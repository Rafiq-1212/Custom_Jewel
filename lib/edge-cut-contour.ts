'use client';

/**
 * Traces the Silhouette Cut boundary out of the existing `masterSketch`.
 * Never a second AI call, and never the raw photo. Runs once per generated
 * sketch and is cached from then on; nothing about switching design/shape
 * or dragging the zoom/position/rotation sliders ever calls this again.
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
 *   -> dilate by the CUT MARGIN: the client's production files (see the
 *      reference DXFs) cut a smooth border a few percent outside the ink,
 *      never flush with it — that margin is the visible metal edge
 *   -> stamp the HANGING RING onto the top centre: a disc that overlaps the
 *      outline so the traced boundary flows around it as one piece, plus
 *      its round hole returned separately (`holes`), the way the reference
 *      files draw two concentric red circles at the top
 *   -> trace, simplify, smooth -> map back into the sketch image's own local
 *      space, centred on the image's centre (the `drawImage(img, -w/2,
 *      -h/2)` convention), so `transformPoints` in lib/pendant-geometry.ts
 *      carries outline and hole through whatever zoom/pan/rotation the
 *      customer applies.
 */

import type { Point, SilhouetteContour } from './pendant-geometry';
import {
  boundingBoxOf,
  dilate,
  erode,
  fillHoles,
  largestComponentMask,
  maskToSmoothContour,
  sealBorderGaps,
} from './silhouette-geometry';

const MAX_ANALYSIS_DIM = 450;
const ALPHA_THRESHOLD = 24;
/** Cut margin outside the ink, as a fraction of the sketch's larger dimension — matches the client's reference files. */
const CUT_MARGIN_FRACTION = 0.035;
/** Hanging ring: outer radius as a fraction of the larger dimension, hole as a fraction of that, and how deep the ring sinks into the outline. */
const RING_OUTER_FRACTION = 0.07;
const RING_HOLE_RATIO = 0.5;
const RING_OVERLAP_RATIO = 0.55;
const RING_HOLE_SEGMENTS = 48;

/** Paints a filled disc into `mask` (in place). */
function stampDisc(mask: Uint8Array, width: number, height: number, cx: number, cy: number, r: number): void {
  const r2 = r * r;
  const minY = Math.max(0, Math.floor(cy - r));
  const maxY = Math.min(height - 1, Math.ceil(cy + r));
  const minX = Math.max(0, Math.floor(cx - r));
  const maxX = Math.min(width - 1, Math.ceil(cx + r));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r2) mask[y * width + x] = 1;
    }
  }
}

function circlePoints(cx: number, cy: number, r: number, segments: number): Point[] {
  const points: Point[] = [];
  for (let i = 0; i < segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    points.push({ x: cx + r * Math.cos(theta), y: cy + r * Math.sin(theta) });
  }
  return points;
}

/**
 * Grows the analysis canvas by `pad` on every side so the cut margin and the
 * ring have room above/around a sketch that is trimmed tight to its ink.
 */
function padMask(mask: Uint8Array, width: number, height: number, pad: number): Uint8Array {
  const paddedWidth = width + pad * 2;
  const out = new Uint8Array(paddedWidth * (height + pad * 2));
  for (let y = 0; y < height; y++) {
    out.set(mask.subarray(y * width, y * width + width), (y + pad) * paddedWidth + pad);
  }
  return out;
}

function decodeImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not decode the sketch image.'));
    image.src = src;
  });
}

export async function extractSilhouetteContour(sketchDataUrl: string): Promise<SilhouetteContour> {
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

  const bridgeRadius = Math.max(3, Math.round(Math.max(analysisWidth, analysisHeight) * 0.015));

  mask = dilate(mask, analysisWidth, analysisHeight, bridgeRadius);
  mask = sealBorderGaps(mask, analysisWidth, analysisHeight, bridgeRadius);
  mask = fillHoles(mask, analysisWidth, analysisHeight);
  mask = erode(mask, analysisWidth, analysisHeight, Math.max(0, bridgeRadius - 1));
  mask = largestComponentMask(mask, analysisWidth, analysisHeight);

  // From here on the mask needs room outside the sketch's own frame: the cut
  // margin grows past every edge and the ring sits above the top. Pad the
  // canvas and keep track of the offset so points still map back into the
  // sketch's own local space below.
  const largerDim = Math.max(analysisWidth, analysisHeight);
  const marginRadius = Math.max(3, Math.round(largerDim * CUT_MARGIN_FRACTION));
  const ringOuter = Math.max(6, Math.round(largerDim * RING_OUTER_FRACTION));
  const pad = marginRadius + ringOuter * 2;
  const paddedWidth = analysisWidth + pad * 2;
  const paddedHeight = analysisHeight + pad * 2;
  mask = padMask(mask, analysisWidth, analysisHeight, pad);

  mask = dilate(mask, paddedWidth, paddedHeight, marginRadius);

  const box = boundingBoxOf(mask, paddedWidth, paddedHeight);
  if (!box) {
    throw new Error('This sketch has no visible artwork to trace a silhouette from.');
  }
  const ringCx = (box.minX + box.maxX + 1) / 2;
  const ringCy = box.minY - ringOuter * (1 - RING_OVERLAP_RATIO);
  stampDisc(mask, paddedWidth, paddedHeight, ringCx, ringCy, ringOuter);
  mask = largestComponentMask(mask, paddedWidth, paddedHeight);

  const smoothed = maskToSmoothContour(mask, paddedWidth, paddedHeight);
  if (!smoothed) {
    throw new Error('This sketch has no visible artwork to trace a silhouette from.');
  }

  const scaleX = naturalWidth / analysisWidth;
  const scaleY = naturalHeight / analysisHeight;
  const toLocal = (p: Point): Point => ({
    x: (p.x - pad) * scaleX - naturalWidth / 2,
    y: (p.y - pad) * scaleY - naturalHeight / 2,
  });

  const points = smoothed.map(toLocal);
  const hole = circlePoints(ringCx, ringCy, ringOuter * RING_HOLE_RATIO, RING_HOLE_SEGMENTS).map(toLocal);

  return { points, holes: [hole], imageWidth: naturalWidth, imageHeight: naturalHeight };
}
