'use client';

/**
 * Traces the Edge Cut boundaries — Free, Bust with Base, Silhouette Band —
 * out of the existing `masterSketch`. Never a second AI call, and never the
 * raw photo. Runs once per generated sketch and is cached from then on;
 * nothing about switching design/shape/style or dragging the
 * zoom/position/rotation sliders ever calls this again.
 *
 * WHY THE SKETCH AND NOT THE PHOTO. An earlier version traced the boundary
 * from the original uploaded photo, reasoning that a photographic
 * subject/background split is cleaner than sparse line art. Verified on a
 * real customer photo (a couple in an arcade) that this is wrong in
 * principle, not just in degree: Gemini *re-composes* the scene — it
 * re-crops, re-frames and re-proportions the people — so even a perfect
 * photo silhouette describes a different picture than the sketch it is
 * meant to bound. The result was a boundary that sliced through the man's
 * face while leaving a floating island above it. A busy background makes
 * the photo segmentation itself fail on top of that. The sketch is what
 * actually gets cut, so the sketch is the only thing its boundary can be
 * traced from — aligned by construction, and it also keeps working after a
 * reload, since the sketch is the one asset that is persisted.
 *
 * The master sketch is line art with a transparent background
 * (lib/image-processing.ts): only the ink is opaque, and the faces, shirts
 * and paper inside the outline are as transparent as the background. So the
 * mask has to be made solid before it can be traced (lib/silhouette-
 * geometry.ts throughout):
 *
 *   decode + downsample -> alpha threshold (ink mask)
 *   -> dilate by a small bridge radius: seals the hairline gaps between
 *      hatching strokes and any small break in the outline, so the interior
 *      is actually enclosed
 *   -> sealBorderGaps: where the subject is cut off by the image edge (a
 *      chest-up torso meeting the bottom row), the edge itself becomes the
 *      closing stroke — otherwise the fill below would leak in through it
 *   -> fillHoles: everything not reachable from the border is subject. This
 *      is what fills the faces/clothes, without growing the outer boundary
 *      or closing the real gap between two heads
 *   -> erode by (bridge radius - 1): undoes the dilation's bloat so the outer
 *      boundary sits back on the ink's own edge, leaving ~1px so the outline
 *      stroke itself is never shaved by the clip
 *   -> keep the largest connected component only (one pendant, one piece)
 *   -> per style: 'bust' splices a rounded base below the shoulder line;
 *      'band' dilates outward by a deliberately wide margin — that offset is
 *      the whole point of the style. 'full' adds nothing: the cut boundary is
 *      the subject's own contour, with no extra stroke, halo, rim or padding
 *   -> trace, simplify, smooth -> map back into the sketch image's own local
 *      space, centred on the image's centre (the `drawImage(img, -w/2,
 *      -h/2)` convention), so `transformPoints` in lib/pendant-geometry.ts
 *      carries it through whatever zoom/pan/rotation the customer applies.
 *
 * All three styles come out of one decode and one fill, so switching between
 * them in the UI is instant.
 */

import type { SilhouetteContour } from './pendant-geometry';
import {
  boundingBoxOf,
  dilate,
  erode,
  fillHoles,
  largestComponentMask,
  maskToSmoothContour,
  rowExtent,
  sealBorderGaps,
} from './silhouette-geometry';

const MAX_ANALYSIS_DIM = 450;
const ALPHA_THRESHOLD = 24;

/**
 * 'bust': replaces everything below a computed shoulder line with a solid,
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
      const belowY = shoulderY + offset;
      const below = belowY < height ? rowExtent(mask, width, belowY) : null;
      if (below) {
        shoulderY = belowY;
        shoulderExtent = below;
        break;
      }
      const aboveY = shoulderY - offset;
      const above = aboveY >= 0 ? rowExtent(mask, width, aboveY) : null;
      if (above) {
        shoulderY = aboveY;
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
          inside = dx * dx + dy * dy <= cornerRadius * cornerRadius;
        }
      }
      if (inside) out[rowOffset + x] = 1;
    }
  }
  return out;
}

export interface SketchSilhouettes {
  full: SilhouetteContour;
  bust: SilhouetteContour;
  band: SilhouetteContour;
}

function decodeImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not decode the sketch image.'));
    image.src = src;
  });
}

export async function extractSketchSilhouettes(sketchDataUrl: string): Promise<SketchSilhouettes> {
  const image = await decodeImage(sketchDataUrl);
  const naturalWidth = image.naturalWidth;
  const naturalHeight = image.naturalHeight;
  if (!naturalWidth || !naturalHeight) {
    throw new Error('Could not read the sketch dimensions.');
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

  let mask: Uint8Array = new Uint8Array(analysisWidth * analysisHeight);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    mask[p] = data[i + 3] >= ALPHA_THRESHOLD ? 1 : 0;
  }

  const largerDim = Math.max(analysisWidth, analysisHeight);
  const bridgeRadius = Math.max(3, Math.round(largerDim * 0.015));

  mask = dilate(mask, analysisWidth, analysisHeight, bridgeRadius);
  mask = sealBorderGaps(mask, analysisWidth, analysisHeight, bridgeRadius);
  mask = fillHoles(mask, analysisWidth, analysisHeight);
  mask = erode(mask, analysisWidth, analysisHeight, Math.max(0, bridgeRadius - 1));
  mask = largestComponentMask(mask, analysisWidth, analysisHeight);

  const bustMask = largestComponentMask(
    applyBustBase(mask, analysisWidth, analysisHeight),
    analysisWidth,
    analysisHeight,
  );
  const bandMask = dilate(mask, analysisWidth, analysisHeight, Math.max(2, Math.round(largerDim * 0.03)));

  const scaleX = naturalWidth / analysisWidth;
  const scaleY = naturalHeight / analysisHeight;
  const toContour = (styled: Uint8Array): SilhouetteContour => {
    const smoothed = maskToSmoothContour(styled, analysisWidth, analysisHeight);
    if (!smoothed) {
      throw new Error('This sketch has no visible artwork to trace an edge-cut boundary from.');
    }
    const points = smoothed.map((p) => ({
      x: p.x * scaleX - naturalWidth / 2,
      y: p.y * scaleY - naturalHeight / 2,
    }));
    return { points, imageWidth: naturalWidth, imageHeight: naturalHeight };
  };

  return { full: toContour(mask), bust: toContour(bustMask), band: toContour(bandMask) };
}
