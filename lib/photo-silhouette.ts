'use client';

/**
 * Traces a jewellery-style silhouette boundary from the ORIGINAL uploaded
 * photo — never the generated sketch. This is deliberate, not an oversight:
 * the sketch (lib/image-processing.ts) is line art with large white regions
 * *inside* clothing and hair, so a background-removal pass run on the sketch
 * itself would leak straight through those gaps into the subject. The real
 * photo has none of that problem — a normal photographic subject-vs-
 * background split — so this module segments the photo instead, and the
 * sketch is used only for the engraving artwork layer (see `paintPendant` in
 * components/PendantPreview.tsx), never for the boundary itself.
 *
 * Still no second AI call: this is a classical, deterministic background-
 * removal heuristic (nearest-border-color classification, border-connected —
 * see `segmentBackground` below for why it's two passes, not one), not a
 * model. It runs once, client-side, right after generation, on the same
 * photo the customer already uploaded — Gemini is never invoked again for
 * it, exactly like the sketch-based fallback in lib/edge-cut-contour.ts this
 * module normally supersedes.
 *
 * Pipeline:
 *   decode + downsample -> segment background from the image border ->
 *   invert to a foreground candidate mask -> `closeToSingleComponent` searches
 *   increasing morphological-close radii (patches holes/gaps from uneven
 *   real-world lighting without growing the outer boundary) until keeping
 *   only the largest connected component recovers most of the raw mask, so
 *   the face/body don't end up traced as disconnected islands -> [style:
 *   'bust' only] replace everything below a shoulder line with a
 *   rounded-rectangle base -> [style: 'band' only] dilate outward by a
 *   deliberately wide margin, the whole point of that style — 'full' and
 *   'bust' add no such margin, the cut boundary is the subject's own contour
 *   with no extra stroke, halo, frame, rim, or padding around it -> trace,
 *   simplify, smooth (lib/silhouette-geometry.ts) -> map back into the
 *   photo's own local coordinate space, centered on the photo's own center,
 *   matching the same convention `extractSilhouetteContour` and
 *   `paintPendant` already use.
 */

import type { SilhouetteContour } from './pendant-geometry';
import {
  boundingBoxOf,
  closeToSingleComponent,
  dilate,
  largestComponentMask,
  maskToSmoothContour,
  rowExtent,
} from './silhouette-geometry';

const MAX_ANALYSIS_DIM = 450;
/** Two pixel colors this close (Euclidean RGB distance) or closer are treated as "the same surface" while growing the background region. */
const COLOR_TOLERANCE = 30;

export type PhotoSilhouetteStyle = 'full' | 'bust' | 'band';

function decodeImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not decode the photo.'));
    image.src = src;
  });
}

/**
 * Two-pass background segmentation. Each pass fixes a real, distinct failure
 * mode found while testing this against actual photos (not just clean
 * synthetic test images) — neither pass alone is sufficient:
 *
 * Pass 1 (color classification): every pixel is compared against a palette
 * of colors actually observed on the image border, independently of its
 * neighbors. A pure border-seeded *region growing* version of this (compare
 * each candidate only to the single neighbor that reached it) has a real
 * failure mode: any anti-aliased edge is itself a short gradient from
 * background to subject color, so the growing region can "tunnel" through
 * that gradient one similar-enough pixel at a time and then keep spreading
 * through the subject's own (internally near-uniform) fill — verified
 * directly on a synthetic portrait, which came back completely hollowed out.
 * Per-pixel classification against a fixed palette has no chain to tunnel
 * through.
 *
 * Pass 2 (border connectivity): classification alone isn't enough either —
 * verified directly on a real photo where a light shirt and a pastel saree
 * were close enough in color to the (also light) backdrop to get classified
 * as background *even though they aren't actually connected to it*, leaving
 * only the subjects' dark hair as the surviving "different enough" region —
 * tiny and unrecognizable once traced. This pass keeps only the
 * color-matched pixels that are *reachable from the real border* by a path
 * through *other* color-matched pixels, so a light garment surrounded by
 * clearly-foreground skin/hair/darker fabric stays foreground even though
 * its own color alone would have matched the backdrop.
 */
function segmentBackground(rgb: Uint8Array, width: number, height: number, tolerance: number): Uint8Array {
  // Bucket-dedupe border colors before matching against them — a smoothly
  // graded backdrop would otherwise contribute one anchor per border pixel.
  const bucketOf = (r: number, g: number, b: number) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
  const seenBuckets = new Set<number>();
  const anchors: number[] = []; // flat [r,g,b, r,g,b, ...]

  const addAnchor = (i: number) => {
    const r = rgb[i * 3];
    const g = rgb[i * 3 + 1];
    const b = rgb[i * 3 + 2];
    const bucket = bucketOf(r, g, b);
    if (seenBuckets.has(bucket)) return;
    seenBuckets.add(bucket);
    anchors.push(r, g, b);
  };

  for (let x = 0; x < width; x++) {
    addAnchor(x);
    addAnchor((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    addAnchor(y * width);
    addAnchor(y * width + width - 1);
  }

  const toleranceSquared = tolerance * tolerance;
  const anchorCount = anchors.length / 3;
  const colorMatch = new Uint8Array(width * height);

  for (let i = 0; i < width * height; i++) {
    const r = rgb[i * 3];
    const g = rgb[i * 3 + 1];
    const b = rgb[i * 3 + 2];
    for (let a = 0; a < anchorCount; a++) {
      const dr = r - anchors[a * 3];
      const dg = g - anchors[a * 3 + 1];
      const db = b - anchors[a * 3 + 2];
      if (dr * dr + dg * dg + db * db <= toleranceSquared) {
        colorMatch[i] = 1;
        break;
      }
    }
  }

  // Pass 2: flood fill from the border, but only ever step onto pixels that
  // independently passed pass 1 — so a color-matched pixel not actually
  // connected to the real border through other color-matched pixels never
  // gets claimed.
  const background = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  let stackLen = 0;

  const claim = (i: number) => {
    if (colorMatch[i] && !background[i]) {
      background[i] = 1;
      stack[stackLen++] = i;
    }
  };

  for (let x = 0; x < width; x++) {
    claim(x);
    claim((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    claim(y * width);
    claim(y * width + width - 1);
  }

  while (stackLen > 0) {
    const i = stack[--stackLen];
    const x = i % width;
    const y = (i / width) | 0;
    if (x > 0) claim(i - 1);
    if (x < width - 1) claim(i + 1);
    if (y > 0) claim(i - width);
    if (y < height - 1) claim(i + width);
  }

  return background;
}

/**
 * Replaces everything below a computed shoulder line with a solid,
 * bottom-rounded rectangular base spanning the silhouette's width at that
 * line — the "bust with base" mount look, built by reshaping the raster
 * mask directly (simplest robust way to splice a straight-edged, precisely
 * rounded base onto an organic traced silhouette).
 */
function applyBustBase(mask: Uint8Array, width: number, height: number): Uint8Array {
  const box = boundingBoxOf(mask, width, height);
  if (!box) return mask;

  const boundingHeight = box.maxY - box.minY;
  let shoulderY = box.minY + Math.round(boundingHeight * 0.5);

  // The chosen row might land in a gap; search outward for the nearest row
  // that actually has foreground to measure a width from.
  let shoulderExtent = rowExtent(mask, width, shoulderY);
  if (!shoulderExtent) {
    for (let offset = 1; offset <= boundingHeight; offset++) {
      const below = rowExtent(mask, width, shoulderY + offset);
      if (below) {
        shoulderY += offset;
        shoulderExtent = below;
        break;
      }
      const above = rowExtent(mask, width, shoulderY - offset);
      if (above) {
        shoulderY -= offset;
        shoulderExtent = above;
        break;
      }
    }
  }
  if (!shoulderExtent) return mask;

  const out = mask.slice();
  const { minX, maxX } = shoulderExtent;
  const baseWidth = maxX - minX + 1;
  const cornerRadius = Math.min(Math.round(baseWidth * 0.18), Math.round((box.maxY - shoulderY) * 0.6));

  for (let y = shoulderY; y <= box.maxY; y++) {
    const rowOffset = y * width;
    for (let x = minX; x <= maxX; x++) {
      // Round only the two bottom corners, near the base's own bottom edge.
      const distFromBottom = box.maxY - y;
      let inside = true;
      if (cornerRadius > 0 && distFromBottom < cornerRadius) {
        const nearLeft = x - minX < cornerRadius;
        const nearRight = maxX - x < cornerRadius;
        if (nearLeft || nearRight) {
          const cx = nearLeft ? minX + cornerRadius : maxX - cornerRadius;
          const cy = box.maxY - cornerRadius;
          const dx = x - cx;
          const dy = y - cy;
          inside = dx * dx + dy * dy <= cornerRadius * cornerRadius || (nearLeft ? dx > 0 : dx < 0);
        }
      }
      if (inside) out[rowOffset + x] = 1;
    }
  }
  return out;
}

export async function extractPhotoSilhouette(
  photoUrl: string,
  style: PhotoSilhouetteStyle = 'full',
): Promise<SilhouetteContour> {
  const image = await decodeImage(photoUrl);
  const naturalWidth = image.naturalWidth;
  const naturalHeight = image.naturalHeight;
  if (!naturalWidth || !naturalHeight) {
    throw new Error('Could not read the photo dimensions.');
  }

  const downscale = Math.min(1, MAX_ANALYSIS_DIM / Math.max(naturalWidth, naturalHeight));
  const analysisWidth = Math.max(1, Math.round(naturalWidth * downscale));
  const analysisHeight = Math.max(1, Math.round(naturalHeight * downscale));

  const canvas = document.createElement('canvas');
  canvas.width = analysisWidth;
  canvas.height = analysisHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas is not available in this browser.');
  ctx.drawImage(image, 0, 0, analysisWidth, analysisHeight);
  const { data } = ctx.getImageData(0, 0, analysisWidth, analysisHeight);

  const rgb = new Uint8Array(analysisWidth * analysisHeight * 3);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    rgb[p * 3] = data[i];
    rgb[p * 3 + 1] = data[i + 1];
    rgb[p * 3 + 2] = data[i + 2];
  }

  const background = segmentBackground(rgb, analysisWidth, analysisHeight, COLOR_TOLERANCE);
  let mask: Uint8Array = new Uint8Array(analysisWidth * analysisHeight);
  for (let i = 0; i < mask.length; i++) mask[i] = background[i] ? 0 : 1;

  mask = closeToSingleComponent(mask, analysisWidth, analysisHeight);

  if (mask.every((v) => v === 0)) {
    throw new Error('Could not separate a subject from the background in this photo.');
  }

  if (style === 'bust') {
    mask = applyBustBase(mask, analysisWidth, analysisHeight);
    mask = largestComponentMask(mask, analysisWidth, analysisHeight);
  }

  // 'band' is explicitly, by name, a silhouette *with a wider outer border*
  // — that offset is the whole point of the style, and stays. 'full' and
  // 'bust' must not add one: the cut boundary is the subject's own contour,
  // full stop — no added stroke, halo, frame, rim, or padding around it.
  if (style === 'band') {
    const marginRadius = Math.max(2, Math.round(Math.max(analysisWidth, analysisHeight) * 0.03));
    mask = dilate(mask, analysisWidth, analysisHeight, marginRadius);
  }

  const smoothed = maskToSmoothContour(mask, analysisWidth, analysisHeight);
  if (!smoothed) {
    throw new Error('Could not trace a silhouette boundary from this photo.');
  }

  const scale = naturalWidth / analysisWidth;
  const points = smoothed.map((p) => ({
    x: p.x * scale - naturalWidth / 2,
    y: p.y * scale - naturalHeight / 2,
  }));

  return { points, imageWidth: naturalWidth, imageHeight: naturalHeight };
}
