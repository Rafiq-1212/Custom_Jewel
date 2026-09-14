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
 *   -> offset by the CUT MARGIN as a true round (Euclidean) offset, then a
 *      pinhole-sized close: the client's production files cut a border a
 *      constant ~2.5% outside the ink that follows every contour of it
 *   -> trace, simplify, smooth the body outline
 *   -> the HANGING RING is sunk into the top of the outline deep enough to
 *      be attached on both sides, unioned in and filleted at both joins, so
 *      the traced cut path flows into it as one curve; its hole is returned
 *      separately (`holes`)
 *   -> map everything back into the sketch image's own local space, centred
 *      on the image's centre (the `drawImage(img, -w/2, -h/2)` convention),
 *      so `transformPoints` in lib/pendant-geometry.ts carries outline,
 *      ring and hole through whatever zoom/pan/rotation the customer applies.
 */

import type { Point, SilhouetteContour } from './pendant-geometry';
import { roundClose, roundDilate, roundErode } from './distance-transform';
import {
  boundingBoxOf,
  fillHoles,
  largestComponentMask,
  maskToSmoothContour,
  sealBorderGaps,
} from './silhouette-geometry';

/**
 * Analysis resolution. The cut line is built from this mask, so it must be
 * fine enough that hair tufts, ears and fingers survive as real contours —
 * at 450 px they blurred into lumps once offset and simplified.
 */
const MAX_ANALYSIS_DIM = 900;
const ALPHA_THRESHOLD = 24;
/**
 * Cut margin outside the ink, as a fraction of the sketch's larger
 * dimension — measured on the client's reference files, whose red line
 * sits a constant ~2.5% outside the artwork.
 */
const CUT_MARGIN_FRACTION = 0.025;
/**
 * A tiny round close after the offset removes pinholes and single-pixel
 * nicks only. Anything larger would fill the real concavities — the gap
 * between two heads, the notch under an ear — that the client's line keeps.
 */
const SMOOTHING_CLOSE_FRACTION = 0.006;
/**
 * Hanging ring, measured against the client's reference files: outer
 * diameter ~14% of the piece's width, hole ~55% of that, and the ring
 * overlapping the top of the outline by a little over half its radius. It
 * is kept as its own complete circle (see `SilhouetteContour.rings`).
 */
const RING_OUTER_FRACTION_OF_WIDTH = 0.07;
const RING_HOLE_RATIO = 0.55;
/**
 * How far the ring's bottom sinks below the outline's top on the LOWER of
 * its two sides (as a fraction of the ring radius). Both sides are measured
 * separately — see `extractSilhouetteContour` — so the ring is attached on
 * either side, never perched on one head with a gap over the other.
 */
const RING_ATTACH_DEPTH_RATIO = 0.35;
/** The ring never sinks more than this far (fraction of radius) into the HIGHER side. */
const RING_MAX_SINK_RATIO = 0.6;
/** Radius of the round close that fillets the two joins between ring and outline, as a fraction of the ring radius. */
const RING_FILLET_RATIO = 0.6;
const RING_SEGMENTS = 72;
/**
 * Curve simplification for the final trace: light, so the line keeps
 * following the ink rather than being rounded into blobs — the round
 * offset above already made it smooth.
 */
const TRACE_EPSILON_FRACTION = 0.0015;
const TRACE_SMOOTHING_ITERATIONS = 2;

/** Topmost foreground row within a horizontal band of columns, or `null` if the band is empty. */
function topOfBand(mask: Uint8Array, width: number, height: number, x0: number, x1: number): number | null {
  const from = Math.max(0, Math.floor(x0));
  const to = Math.min(width - 1, Math.ceil(x1));
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = from; x <= to; x++) if (mask[row + x] === 1) return y;
  }
  return null;
}

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
    throw new Error('We couldn\'t read this sketch.');
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

  mask = roundDilate(mask, analysisWidth, analysisHeight, bridgeRadius);
  mask = sealBorderGaps(mask, analysisWidth, analysisHeight, bridgeRadius);
  mask = fillHoles(mask, analysisWidth, analysisHeight);
  mask = roundErode(mask, analysisWidth, analysisHeight, Math.max(0, bridgeRadius - 1));
  mask = largestComponentMask(mask, analysisWidth, analysisHeight);

  // From here on the mask needs room outside the sketch's own frame: the cut
  // margin grows past every edge and the ring sits above the top. Pad the
  // canvas and keep track of the offset so points still map back into the
  // sketch's own local space below.
  const largerDim = Math.max(analysisWidth, analysisHeight);
  const marginRadius = Math.max(3, Math.round(largerDim * CUT_MARGIN_FRACTION));
  const smoothingRadius = Math.round(largerDim * SMOOTHING_CLOSE_FRACTION);
  // Room for every growth step below, including the ring above the top — a
  // close that touches the canvas edge would leave a flat artefact there.
  const ringEstimate = Math.ceil((analysisWidth + marginRadius * 2) * RING_OUTER_FRACTION_OF_WIDTH);
  const pad = marginRadius + smoothingRadius * 2 + ringEstimate * 3;
  const paddedWidth = analysisWidth + pad * 2;
  const paddedHeight = analysisHeight + pad * 2;
  mask = padMask(mask, analysisWidth, analysisHeight, pad);

  // A true round offset (Euclidean distance <= margin), not a box filter —
  // see lib/distance-transform.ts for why that matters at every corner.
  mask = roundDilate(mask, paddedWidth, paddedHeight, marginRadius);
  mask = roundClose(mask, paddedWidth, paddedHeight, smoothingRadius);
  mask = largestComponentMask(mask, paddedWidth, paddedHeight);

  const box = boundingBoxOf(mask, paddedWidth, paddedHeight);
  if (!box) {
    throw new Error('We couldn\'t find a clear outline in this sketch.');
  }

  // The ring sits at the top centre of the piece and must be ATTACHED ON
  // BOTH SIDES. The outline's top is measured separately under the left and
  // right halves of the ring's footprint — with two heads of different
  // height (or a single head's sloping hair) those differ, and a ring hung
  // off just the higher one would touch it at a point and float over the
  // other side. The ring sinks until its bottom is below the LOWER of the
  // two tops, capped so it never disappears into the higher one.
  const ringOuter = Math.max(6, Math.round((box.maxX - box.minX + 1) * RING_OUTER_FRACTION_OF_WIDTH));
  const ringCx = (box.minX + box.maxX + 1) / 2;
  const topLeft = topOfBand(mask, paddedWidth, paddedHeight, ringCx - ringOuter, ringCx - ringOuter * 0.2);
  const topRight = topOfBand(mask, paddedWidth, paddedHeight, ringCx + ringOuter * 0.2, ringCx + ringOuter);
  const tops = [topLeft, topRight].filter((t): t is number => t !== null);
  const lowerTop = tops.length ? Math.max(...tops) : box.minY;
  const higherTop = tops.length ? Math.min(...tops) : box.minY;
  let ringCy = lowerTop + ringOuter * RING_ATTACH_DEPTH_RATIO - ringOuter;
  ringCy = Math.max(ringCy, higherTop + ringOuter * RING_MAX_SINK_RATIO - ringOuter);

  // Union the ring into the piece and fillet both joins, so the traced cut
  // path flows from the outline into the ring on either side as one curve;
  // the hole is the only separate cut.
  stampDisc(mask, paddedWidth, paddedHeight, ringCx, ringCy, ringOuter);
  mask = roundClose(mask, paddedWidth, paddedHeight, Math.round(ringOuter * RING_FILLET_RATIO));
  mask = largestComponentMask(mask, paddedWidth, paddedHeight);

  const smoothed = maskToSmoothContour(mask, paddedWidth, paddedHeight, {
    epsilonFraction: TRACE_EPSILON_FRACTION,
    smoothingIterations: TRACE_SMOOTHING_ITERATIONS,
  });
  if (!smoothed) {
    throw new Error('We couldn\'t find a clear outline in this sketch.');
  }

  const scaleX = naturalWidth / analysisWidth;
  const scaleY = naturalHeight / analysisHeight;
  const toLocal = (p: Point): Point => ({
    x: (p.x - pad) * scaleX - naturalWidth / 2,
    y: (p.y - pad) * scaleY - naturalHeight / 2,
  });

  return {
    points: smoothed.map(toLocal),
    rings: [],
    holes: [circlePoints(ringCx, ringCy, ringOuter * RING_HOLE_RATIO, RING_SEGMENTS).map(toLocal)],
    imageWidth: naturalWidth,
    imageHeight: naturalHeight,
  };
}
