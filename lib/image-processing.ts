/**
 * Deterministic post-processing of the Gemini sketch into the master asset.
 *
 * THIS FILE CONTAINS NO AI CALLS. Everything here is pixel arithmetic run
 * once, immediately after Gemini returns, on the one sketch that generation
 * ever produces. It exists to fix a real defect: the raw Gemini output is a
 * black-on-white rectangle, and compositing a white rectangle into a heart
 * (even with a multiply blend) leaves a faint but real seam wherever the
 * rectangle's edge falls inside the shape — worse, it makes "don't show a
 * rectangular boundary" impossible to fully guarantee, because there is
 * always *some* zoom/pan where that edge is visible.
 *
 * The fix is to make the rectangle stop existing: crop to the actual ink,
 * then turn every remaining near-white pixel transparent. What's left is a
 * masterSketch with no background at all — only the linework has opacity —
 * so there is no rectangle for any transform to ever reveal.
 *
 * `MasterSketchOptions.cropBelowJaw` (Face Pendant only) additionally
 * shortens that crop to end at the jaw — see `computeFaceCropBox` below,
 * and `cropPhotoToHead`, which does the same measurement on the photo
 * earlier in the pipeline.
 */

import sharp from 'sharp';

if (typeof window !== 'undefined') {
  throw new Error('lib/image-processing.ts was imported into a browser bundle. This module is server-only.');
}

/** Pixels this light or lighter are treated as background, not ink. */
const WHITE_THRESHOLD = 245;
/** Below this, a pixel is fully opaque ink; between here and the threshold, alpha ramps down. */
const INK_THRESHOLD = 225;
/** Sharp's `trim` needs some tolerance — Gemini's "white" is rarely pure 255. */
const TRIM_THRESHOLD = 12;

export interface MasterSketch {
  buffer: Buffer;
  width: number;
  height: number;
  contentType: 'image/png';
}

export interface MasterSketchOptions {
  /**
   * Face Pendant is cut to the head on the photo, before the drawing starts
   * (`cropPhotoToHead`). This is the backstop for what is left: a neck the
   * photo crop's plateau test did not catch, or one the finish step drew
   * below the chin anyway. Measured from the alpha mask's own geometry, so
   * it never costs another AI call. See `computeFaceCropBox`.
   */
  cropBelowJaw?: boolean;
}

/** Pixels this opaque or more count as "ink" when measuring the mask's own shape below. */
const NECK_DETECT_ALPHA = 40;
/** A row narrower than this fraction of the head's own peak width counts as "at the jaw". */
const CHIN_WIDTH_RATIO = 0.62;
/** Rows narrower than this fraction of the peak are treated as a vanishing tip, not a neck. */
const NECK_FLOOR_RATIO = 0.15;
/** Row-to-row width change, as a fraction of the peak width, still counted as "flat" (cylindrical). */
const PLATEAU_DELTA_RATIO = 0.05;

/**
 * Finds the tight content bounding box of the alpha mask — and, when
 * `detectNeck` is set, shortens it to end at the jaw instead of the full
 * content height.
 *
 * The neck heuristic needs no face detector, but it does need to tell a real
 * neck apart from an ordinary tapering chin/jawline, which also "narrows
 * below the head's width" — the naive version of this check (verified
 * directly against a synthetic head-only silhouette before shipping) wrongly
 * cropped a perfectly correct chin, because *any* continuously-tapering
 * curve stays "narrow" for a while on its way to a point. The real
 * distinguishing signature is shape, not just width: a neck is roughly
 * cylindrical — width holds close to *constant* over a sustained run of
 * rows — while a natural taper keeps *shrinking* toward zero the whole way
 * down. So below the jaw, this looks for the longest run of consecutive
 * rows whose width is both below the jaw threshold and essentially flat
 * from one row to the next; only a genuine plateau like that counts as a
 * neck. Deliberately conservative in both directions — it only fires on a
 * clear, sustained plateau, and never removes more than 60% or less than 4%
 * of the content — because an undetected neck is a smaller defect than
 * wrongly decapitating an already-correct crop.
 */
function computeFaceCropBox(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  detectNeck: boolean,
): { left: number; top: number; width: number; height: number } | null {
  const rowMinX = new Int32Array(height).fill(-1);
  const rowMaxX = new Int32Array(height).fill(-1);
  const rowWidth = new Int32Array(height);

  for (let y = 0; y < height; y++) {
    let minX = -1;
    let maxX = -1;
    const rowStart = y * width * channels;
    for (let x = 0; x < width; x++) {
      if (data[rowStart + x * channels + 3] >= NECK_DETECT_ALPHA) {
        if (minX === -1) minX = x;
        maxX = x;
      }
    }
    rowMinX[y] = minX;
    rowMaxX[y] = maxX;
    rowWidth[y] = minX === -1 ? 0 : maxX - minX + 1;
  }

  let topY = -1;
  let bottomY = -1;
  for (let y = 0; y < height; y++) {
    if (rowWidth[y] > 0) {
      if (topY === -1) topY = y;
      bottomY = y;
    }
  }
  if (topY === -1) return null;
  const contentHeight = bottomY - topY + 1;

  let keptBottomY = bottomY;

  if (detectNeck && contentHeight >= 40) {
    // Light smoothing so hand-drawn hatching texture doesn't register as
    // width noise and break up an otherwise-real plateau.
    const smoothed = new Float64Array(height);
    for (let y = topY; y <= bottomY; y++) {
      let sum = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < topY || yy > bottomY) continue;
        sum += rowWidth[yy];
        count++;
      }
      smoothed[y] = sum / count;
    }

    // The head's own widest point (hair/ears) — restricted to the upper
    // portion of the content so a *second*, wider re-flare further down
    // (shoulders) is never mistaken for "the head" and used as the peak.
    let maxWidth = 0;
    let peakY = topY;
    const peakSearchEnd = topY + Math.round(contentHeight * 0.65);
    for (let y = topY; y <= peakSearchEnd; y++) {
      if (smoothed[y] > maxWidth) {
        maxWidth = smoothed[y];
        peakY = y;
      }
    }

    if (maxWidth > 0) {
      let chinY = -1;
      const chinThreshold = maxWidth * CHIN_WIDTH_RATIO;
      for (let y = peakY + 1; y <= bottomY; y++) {
        if (smoothed[y] > 0 && smoothed[y] <= chinThreshold) {
          chinY = y;
          break;
        }
      }

      if (chinY !== -1) {
        const floorWidth = maxWidth * NECK_FLOOR_RATIO;
        const maxDelta = Math.max(1.5, maxWidth * PLATEAU_DELTA_RATIO);

        // Longest run, anywhere below the jaw, of consecutive rows that are
        // both in the "neck-narrow, not a vanishing tip" band and roughly
        // flat relative to the row that started the run — the cylindrical-
        // width signature a natural taper never has. Comparing to the run's
        // *start* width, not just the previous row, matters: a continuous
        // taper's row-to-row steps can each individually be smaller than
        // `maxDelta` (verified directly — a synthetic ellipse's tail was
        // still misclassified as a plateau when only adjacent rows were
        // compared), even though the shape is unmistakably still shrinking
        // over any wider span.
        let bestRunStart = -1;
        let bestRunLen = 0;
        let curStart = -1;
        let curLen = 0;
        for (let y = chinY; y <= bottomY; y++) {
          const w = smoothed[y];
          const inBand = w >= floorWidth && w <= chinThreshold;
          const flatFromRunStart = curLen > 0 && curStart !== -1 && Math.abs(w - smoothed[curStart]) <= maxDelta;
          if (inBand && (curLen === 0 || flatFromRunStart)) {
            if (curLen === 0) curStart = y;
            curLen++;
          } else if (inBand) {
            curStart = y;
            curLen = 1;
          } else {
            curLen = 0;
            curStart = -1;
          }
          if (curLen > bestRunLen) {
            bestRunLen = curLen;
            bestRunStart = curStart;
          }
        }

        const minPlateauLen = Math.max(12, Math.round(contentHeight * 0.05));
        if (bestRunLen >= minPlateauLen && bestRunStart !== -1) {
          const removedFraction = (bottomY - bestRunStart + 1) / contentHeight;
          if (removedFraction >= 0.04 && removedFraction <= 0.6) {
            const margin = Math.max(2, Math.round(contentHeight * 0.01));
            keptBottomY = Math.max(chinY, Math.min(bottomY, bestRunStart - margin));
          }
        }
      }
    }
  }

  // The tight left/right bound of *only the kept rows* — if a removed neck
  // flared into shoulders wider than the head, the original full-content
  // bounding box would leave dead space on both sides once those rows are
  // gone, shrinking the face within the pendant for no reason.
  let minX = width;
  let maxX = -1;
  for (let y = topY; y <= keptBottomY; y++) {
    if (rowMinX[y] === -1) continue;
    if (rowMinX[y] < minX) minX = rowMinX[y];
    if (rowMaxX[y] > maxX) maxX = rowMaxX[y];
  }
  if (maxX === -1) return null;

  return { left: minX, top: topY, width: maxX - minX + 1, height: keptBottomY - topY + 1 };
}

/**
 * Lifts an off-white "paper" background to true white before any
 * thresholding. The background tone is measured directly, as the per-channel
 * median of the image's outer border ring (where there is never artwork, only
 * background), and every channel is rescaled so that tone becomes 255.
 *
 * This exists because `normalise()` below is not enough on its own: it
 * stretches the 1st-99th percentile range, so the moment a drawing contains
 * real white (skin, a white shirt) the top percentile is already 255 and a
 * grey paper background stays exactly where it was. Verified on a real
 * generation: a background at luminance ~234 landed inside the alpha ramp
 * and 98% of the frame came out semi-opaque grey.
 */
async function liftBackgroundToWhite(input: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(input).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const ring = Math.max(2, Math.round(Math.max(width, height) * 0.02));

  const samples: [number[], number[], number[]] = [[], [], []];
  for (let y = 0; y < height; y++) {
    const inRing = y < ring || y >= height - ring;
    for (let x = 0; x < width; x++) {
      if (!inRing && x >= ring && x < width - ring) continue;
      const i = (y * width + x) * channels;
      samples[0].push(data[i]);
      samples[1].push(data[i + 1]);
      samples[2].push(data[i + 2]);
    }
  }
  const median = (values: number[]) => {
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  };
  const background = samples.map(median);

  // Already white enough for the thresholds below — leave the pixels alone.
  if (Math.min(...background) >= WHITE_THRESHOLD) return input;

  for (let i = 0; i < data.length; i += channels) {
    for (let c = 0; c < 3; c++) {
      data[i + c] = Math.min(255, Math.round((data[i + c] * 255) / Math.max(1, background[c])));
    }
  }
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

/**
 * Cuts a white-background photo down to the head, using the same jaw
 * geometry as the sketch crop above.
 *
 * Face Pendant used to get its framing from the photo-edit prompt ("paint
 * everything below the chin white"). Verified on a real customer photo: that
 * instruction makes the model stop editing and start re-rendering — it
 * turned a man photographed at three-quarters to face the camera, twice out
 * of two runs, which then flowed through the trace into the sketch. Asking
 * only for a background removal keeps the pose, so the framing is done here
 * instead, on pixels, where it cannot invent anything.
 *
 * Measured on the photo, where the subject is a solid silhouette against
 * flat white, instead of on hatched line art.
 *
 * `computeFaceCropBox` above is not the right test here: it looks for a
 * cylindrical neck plateau, because it has to survive being handed a picture
 * that is *already* head-only, where cutting at the jaw would shave the chin.
 *
 * Nor is a narrow neck the right thing to look for on a photo. Measured on
 * six different photo edits of the same portrait: on a head turned to one
 * side, with hair and a beard, the silhouette does not pinch at the neck at
 * all — it holds the head's own width and then simply STEPS OUT into the
 * shoulders. An earlier version hunted for the narrowest row between head
 * and shoulders and, on a frame where the head sat high and small, found a
 * dip inside the chest instead and cut the man in half.
 *
 * So what is measured here is that step. The head is a run of roughly
 * constant width near the top; the body is where the silhouette leaves that
 * width behind and stays out. The cut goes at the last row still at head
 * width. A picture that is already head-only never steps out — its width
 * only tapers away below the chin — so it is returned untouched.
 */
/** The head's own width, taken as the median over this band of the subject. */
const HEAD_BAND = { from: 0.1, to: 0.35 };
/** Wider than the head by this much, and the silhouette has reached the shoulders. */
const SHOULDER_STEP_RATIO = 1.25;
/** The step has to hold for this fraction of the subject's height to count (not a stray bulge). */
const SHOULDER_SUSTAIN = 0.04;
/** Rows within this much of the head's width still count as the head. */
const HEAD_TOLERANCE = 1.05;
/** Never cut higher than this fraction of the subject: above it, something is wrong with the measurement. */
const MIN_HEAD_FRACTION = 0.3;
/**
 * What is kept has to be at least this tall relative to the width measured
 * as "the head", since a head is never a wide, flat strip. Verified on a
 * group photo handed to Face Pendant by mistake: the band across three
 * heads measured 577 px "wide" and the cut landed 254 px below the top,
 * which would have sliced a strip off the tops of everyone's heads. With
 * this check the picture is simply left alone instead.
 */
const MIN_HEAD_ASPECT = 0.6;
/**
 * The cut is faded to white over this fraction of the head's height rather
 * than stopping dead. A hard edge is an edge like any other: the ink filter
 * traces it and the finish step draws it, which on a long beard came back as
 * a straight line ruled across the chin. Fading it means the beard simply
 * runs out of ink at the bottom, the way the client's own artwork ends.
 */
const CUT_FEATHER = 0.08;
/**
 * The step to the shoulders sits below the neck, so on its own that cut
 * keeps the neck. When there is a beard, its lowest row is the jaw: a row
 * whose subject pixels are at least this dark, by this share, is beard.
 */
const BEARD_DARK_LUMINANCE = 90;
const BEARD_ROW_SHARE = 0.4;
/** Kept below the beard's last row so its tip is never shaved, as a fraction of the head's height. */
const BEARD_MARGIN = 0.015;
/**
 * On a head turned to one side, the neck also shows BESIDE the beard, in the
 * same rows as it, where no row cut can reach it. In the lower part of the
 * head the beard runs along the jaw from the chin to the ear, so on that
 * side everything outside the beard's edge is neck. The band starts below
 * the ear (the lobe sits at about 55-58% of the head's height on the photo
 * edits measured; 62% leaves a margin), and only the side that has skin
 * beyond the beard is touched, so the far cheek is never nibbled. The band
 * starts as high as the ear allows: the lobe sat at 55-58% on every photo
 * edit measured, and the strip of neck left under it at 62% was still
 * coming back as a stroke hanging off the ear.
 */
const NECK_BAND_START = 0.61;
/** Going up, the beard's edge may move outward by at most this much per row (fraction of width); more is the hair behind the ear. */
const EDGE_SLACK_PER_ROW = 0.002;
/** The beard's edge is where the dark pixels are dense over this window (fraction of width), not the last stray hair. */
const BEARD_EDGE_WINDOW = 0.012;
/** The edge is median-smoothed over this many rows (fraction of head height), so it cannot leave streaks. */
const BEARD_EDGE_SMOOTHING = 0.02;
/** Left untouched beyond the edge so the beard's outline survives, as a fraction of width. */
const NECK_MARGIN = 0.008;
/** The removal fades in sideways over this fraction of width, and downwards over this fraction of head height. */
const NECK_FEATHER_X = 0.02;
const NECK_FEATHER_Y = 0.02;
/** The neck side has to have at least this many times more skin beyond the beard than the other side. */
const NECK_SIDE_RATIO = 1.5;
/** Which side the neck is on is judged from this fraction of the head's height down (below the mouth). */
const NECK_SIDE_DECIDE_FROM = 0.7;
/**
 * A collar stands up beside the neck and survives the straight cut, joined
 * to the beard, so it cannot be separated as its own piece — measured: the
 * head and the collar come back as one connected blob. Colour does separate
 * them: in the band just above the cut, cloth is light and almost grey,
 * while skin is much darker and clearly warm.
 */
const FABRIC_LUMINANCE = 200;
const FABRIC_SATURATION = 0.25;
/** How far above the cut the cloth is looked for, as a fraction of the subject's height. */
const FABRIC_BAND = 0.2;
/** If more than this share of that band would go, the measurement is wrong and nothing is removed. */
const MAX_FABRIC_SHARE = 0.6;

/**
 * Whites out the cloth left standing beside the neck after the cut.
 *
 * Only cloth that runs down to the cut itself is removed, and only within a
 * band above it: the flood starts on the cut row and travels up through
 * light, colourless pixels. A bright highlight on a cheek is never reached,
 * because it does not touch the cut row. Skin survives on colour: measured
 * on a real photo edit, the band above the cut held about 12,000 pixels of
 * light grey cloth against a face whose own pixels sit far darker and warmer.
 *
 * Light cloth only. A dark collar reads like hair or beard to this test and
 * is left alone.
 */
function removeClothAtCut(data: Buffer, width: number, height: number, channels: number, topY: number, cutY: number): void {
  const luminanceAt = (i: number) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  const saturationAt = (i: number) => {
    const max = Math.max(data[i], data[i + 1], data[i + 2]);
    const min = Math.min(data[i], data[i + 1], data[i + 2]);
    return max === 0 ? 0 : (max - min) / max;
  };
  const isCloth = (p: number) => {
    const i = p * channels;
    const luminance = luminanceAt(i);
    return luminance < WHITE_THRESHOLD && luminance >= FABRIC_LUMINANCE && saturationAt(i) < FABRIC_SATURATION;
  };

  const bandTop = Math.max(topY, cutY - Math.round((cutY - topY) * FABRIC_BAND));
  let bandSubject = 0;
  for (let y = bandTop; y <= cutY; y++) {
    for (let x = 0; x < width; x++) if (luminanceAt((y * width + x) * channels) < WHITE_THRESHOLD) bandSubject++;
  }
  if (bandSubject === 0) return;

  const seen = new Uint8Array(width * height);
  const stack: number[] = [];
  for (let x = 0; x < width; x++) {
    const p = cutY * width + x;
    if (!seen[p] && isCloth(p)) {
      seen[p] = 1;
      stack.push(p);
    }
  }

  const found: number[] = [];
  while (stack.length) {
    const p = stack.pop() as number;
    found.push(p);
    const x = p % width;
    const y = (p - x) / width;
    const visit = (q: number, qy: number) => {
      if (qy < bandTop || qy > cutY || seen[q] || !isCloth(q)) return;
      seen[q] = 1;
      stack.push(q);
    };
    if (x > 0) visit(p - 1, y);
    if (x < width - 1) visit(p + 1, y);
    if (y > bandTop) visit(p - width, y - 1);
    if (y < cutY) visit(p + width, y + 1);
  }

  if (found.length > bandSubject * MAX_FABRIC_SHARE) {
    console.info(`[sketch] left the cloth beside the neck alone: it would have taken ${found.length} of ${bandSubject} pixels`);
    return;
  }
  for (const p of found) data.fill(255, p * channels, p * channels + channels);
  if (found.length > 0) console.info(`[sketch] removed ${found.length} pixels of cloth beside the neck`);
}

/**
 * Whites out the neck showing beside the beard on the turned side. Only
 * called when a beard was found. See NECK_BAND_START for the reasoning.
 */
function removeNeckBesideBeard(data: Buffer, width: number, height: number, channels: number, topY: number, cutY: number): void {
  const luminanceAt = (p: number) => {
    const i = p * channels;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  };
  const headHeight = cutY - topY;
  const bandTop = topY + Math.round(headHeight * NECK_BAND_START);
  if (bandTop >= cutY) return;

  const searchTop = bandTop;

  // Per row, the beard's dense-dark extent.
  const window = Math.max(5, Math.round(width * BEARD_EDGE_WINDOW));
  const half = Math.floor(window / 2);
  const edgeLeft = new Int32Array(height).fill(-1);
  const edgeRight = new Int32Array(height).fill(-1);
  const dark = new Uint8Array(width);
  for (let y = searchTop; y <= cutY; y++) {
    for (let x = 0; x < width; x++) dark[x] = luminanceAt(y * width + x) < BEARD_DARK_LUMINANCE ? 1 : 0;
    let run = 0;
    for (let x = 0; x < window && x < width; x++) run += dark[x];
    for (let x = half; x < width - half; x++) {
      if (x > half) run += dark[x + half] - dark[x - half - 1];
      if (run >= window * 0.5) {
        if (edgeLeft[y] < 0) edgeLeft[y] = x;
        edgeRight[y] = x;
      }
    }
  }

  // Median over neighbouring rows: a stray hair or a shadow on one row must
  // not move the edge, or the removal comes out as horizontal streaks.
  const radius = Math.max(2, Math.round(headHeight * BEARD_EDGE_SMOOTHING));
  const median = (edges: Int32Array, y: number) => {
    const values: number[] = [];
    for (let k = -radius; k <= radius; k++) {
      const yy = y + k;
      if (yy >= searchTop && yy <= cutY && edges[yy] >= 0) values.push(edges[yy]);
    }
    if (values.length === 0) return -1;
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  };
  const smoothLeft = new Int32Array(height).fill(-1);
  const smoothRight = new Int32Array(height).fill(-1);
  for (let y = searchTop; y <= cutY; y++) {
    smoothLeft[y] = median(edgeLeft, y);
    smoothRight[y] = median(edgeRight, y);
  }
  // The neck is on whichever side has skin beyond the beard. Decided on the
  // lower rows only: higher up, at the mouth, the far cheek also lies
  // beyond the beard's edge and would make the two sides look even.
  let beyondLeft = 0;
  let beyondRight = 0;
  const decideFrom = topY + Math.round(headHeight * NECK_SIDE_DECIDE_FROM);
  for (let y = Math.max(bandTop, decideFrom); y <= cutY; y++) {
    if (smoothRight[y] < 0) continue;
    for (let x = 0; x < width; x++) {
      if (luminanceAt(y * width + x) >= WHITE_THRESHOLD) continue;
      if (x > smoothRight[y]) beyondRight++;
      if (x < smoothLeft[y]) beyondLeft++;
    }
  }
  if (beyondLeft === 0 && beyondRight === 0) return;
  // Only when one side is clearly the neck side. On the four photo edits
  // measured the ratio was 3 to 1 or better; anything close to even means
  // the picture is not the turned head this is written for, and nothing is
  // safer than guessing at a cheek.
  if (Math.max(beyondLeft, beyondRight) < Math.min(beyondLeft, beyondRight) * NECK_SIDE_RATIO) return;
  const rightSide = beyondRight >= beyondLeft;

  // Up at ear level the dense dark run is no longer the beard but the hair
  // behind the ear, so the edge leaps outward (measured: from ~551 to ~625
  // on a 768 px frame, at 66% of the head) and those rows had "nothing
  // beyond the edge". That left a strip of neck under the ear lobe with a
  // hard straight bottom, traced as a mark hanging off the ear. So, on the
  // neck side only, the edge is carried up from the cut and may only move
  // outward a little per row: enough for the jaw widening gently towards
  // the ear, not enough to follow the leap to the hair.
  const decided = rightSide ? smoothRight : smoothLeft;
  const carried = new Int32Array(height).fill(-1);
  const slack = Math.max(1, width * EDGE_SLACK_PER_ROW);
  let last = -1;
  for (let y = cutY; y >= bandTop; y--) {
    const e = decided[y];
    if (last < 0) last = e;
    else if (e >= 0) last = rightSide ? Math.min(e, last + slack) : Math.max(e, last - slack);
    carried[y] = last;
  }

  const margin = Math.round(width * NECK_MARGIN);
  const featherX = Math.max(2, Math.round(width * NECK_FEATHER_X));
  const featherY = Math.max(1, headHeight * NECK_FEATHER_Y);
  let touched = 0;
  for (let y = bandTop; y <= cutY; y++) {
    const edge = carried[y];
    if (edge < 0) continue;
    const fadeIn = Math.min(1, (y - bandTop) / featherY);
    for (let x = 0; x < width; x++) {
      const beyond = rightSide ? x - (edge + margin) : edge - margin - x;
      if (beyond <= 0) continue;
      const p = y * width + x;
      if (luminanceAt(p) >= WHITE_THRESHOLD) continue;
      const toWhite = Math.min(1, beyond / featherX) * fadeIn;
      const i = p * channels;
      for (let c = 0; c < 3; c++) data[i + c] = Math.round(data[i + c] + (255 - data[i + c]) * toWhite);
      touched++;
    }
  }
  if (touched > 0) console.info(`[sketch] removed ${touched} pixels of neck beside the beard (${rightSide ? 'right' : 'left'} side)`);
}

export async function cropPhotoToHead(photo: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(photo)
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = new Int32Array(info.height);
  for (let y = 0; y < info.height; y++) {
    let minX = -1;
    let maxX = -1;
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      const luminance = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (luminance < WHITE_THRESHOLD) {
        if (minX === -1) minX = x;
        maxX = x;
      }
    }
    width[y] = minX === -1 ? 0 : maxX - minX + 1;
  }

  let topY = -1;
  let bottomY = -1;
  for (let y = 0; y < info.height; y++) {
    if (width[y] > 0) {
      if (topY === -1) topY = y;
      bottomY = y;
    }
  }
  if (topY === -1) return photo;
  const content = bottomY - topY + 1;
  if (content < 40) return photo;

  // Smoothed, so a stray wisp of hair or an earring cannot be read as a step.
  const span = Math.max(1, Math.round(content * 0.01));
  const smooth = new Float64Array(info.height);
  for (let y = topY; y <= bottomY; y++) {
    let sum = 0;
    let count = 0;
    for (let i = -span; i <= span; i++) {
      const yy = y + i;
      if (yy < topY || yy > bottomY) continue;
      sum += width[yy];
      count++;
    }
    smooth[y] = sum / count;
  }

  // The head's width: the median of the band below the crown (where the
  // silhouette is still ramping up) and above the shoulders.
  const bandFrom = topY + Math.round(content * HEAD_BAND.from);
  const bandTo = topY + Math.round(content * HEAD_BAND.to);
  const band: number[] = [];
  for (let y = bandFrom; y <= bandTo; y++) band.push(smooth[y]);
  if (band.length === 0) return photo;
  band.sort((a, b) => a - b);
  const headWidth = band[Math.floor(band.length / 2)];
  if (headWidth <= 0) return photo;

  // Where the silhouette steps out to the shoulders and stays out.
  const step = headWidth * SHOULDER_STEP_RATIO;
  const sustain = Math.max(4, Math.round(content * SHOULDER_SUSTAIN));
  let shoulderY = -1;
  for (let y = bandTo + 1; y <= bottomY - sustain; y++) {
    if (smooth[y] <= step) continue;
    let held = true;
    for (let i = 1; i <= sustain && held; i++) if (smooth[y + i] <= step) held = false;
    if (held) {
      shoulderY = y;
      break;
    }
  }
  // No step out: this picture is already head-only (its width just tapers
  // below the chin), so there is nothing to remove.
  if (shoulderY === -1) return photo;

  // Back up to the last row that is still at head width — the jaw, above
  // where the shoulders start to appear.
  let cutY = -1;
  for (let y = bandTo; y < shoulderY; y++) if (smooth[y] <= headWidth * HEAD_TOLERANCE) cutY = y;
  if (cutY === -1) cutY = shoulderY;
  if (cutY - topY < content * MIN_HEAD_FRACTION) return photo;
  if (cutY - topY < headWidth * MIN_HEAD_ASPECT) return photo;
  if (cutY >= bottomY) return photo;

  // With a beard, the picture should end where the beard ends, not where
  // the shoulders begin: the rows in between are neck. Measured on the
  // photo edits: the beard rows are 60-80% dark right down to the jaw, the
  // neck rows below them are skin. Scanning up from the cut, the first
  // beard row found is the jaw. A face without a beard never triggers this
  // and keeps the shoulder cut.
  let jawY = -1;
  for (let y = cutY; y > bandTo; y--) {
    let subject = 0;
    let dark = 0;
    const row = y * info.width * info.channels;
    for (let x = 0; x < info.width; x++) {
      const i = row + x * info.channels;
      const luminance = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (luminance >= WHITE_THRESHOLD) continue;
      subject++;
      if (luminance < BEARD_DARK_LUMINANCE) dark++;
    }
    if (subject > 0 && dark / subject >= BEARD_ROW_SHARE) {
      jawY = y;
      break;
    }
  }
  if (jawY !== -1) {
    const withMargin = Math.min(cutY, jawY + Math.round((cutY - topY) * BEARD_MARGIN));
    if (withMargin < cutY) {
      console.info(`[sketch] beard ends at row ${jawY}; cutting there instead of at the shoulders (row ${cutY})`);
      cutY = withMargin;
    }
  }

  // Painted white rather than cropped away, so the head keeps the natural
  // silhouette of its own chin and beard instead of ending on a straight
  // cut, exactly as it did when the photo-edit prompt still did this.
  for (let y = cutY + 1; y < info.height; y++) {
    data.fill(255, y * info.width * info.channels, (y + 1) * info.width * info.channels);
  }
  // Cloth first: the fade below would turn the cut row white, and the cloth
  // flood starts from that row.
  removeClothAtCut(data, info.width, info.height, info.channels, topY, cutY);
  if (jawY !== -1) removeNeckBesideBeard(data, info.width, info.height, info.channels, topY, cutY);
  const feather = Math.max(1, Math.round((cutY - topY) * CUT_FEATHER));
  for (let y = Math.max(topY, cutY - feather); y <= cutY; y++) {
    const toWhite = 1 - (cutY - y) / feather;
    const row = y * info.width * info.channels;
    for (let x = 0; x < info.width; x++) {
      const i = row + x * info.channels;
      for (let c = 0; c < 3; c++) data[i + c] = Math.round(data[i + c] + (255 - data[i + c]) * toWhite);
    }
  }

  console.info(
    `[sketch] cut the body off below the head (row ${cutY} of ${info.height}, head width ${Math.round(headWidth)}, shoulders at ${shoulderY})`,
  );
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .png()
    .toBuffer();
}

/**
 * Crop the AI's generous white margin to the actual artwork, then convert
 * every near-white pixel to transparent, ramping alpha across the threshold
 * band so anti-aliased line edges don't get a hard, jagged cutout.
 */
export async function makeTransparentMasterSketch(
  input: Buffer,
  options: MasterSketchOptions = {},
): Promise<MasterSketch> {
  const opaque = await sharp(input).flatten({ background: '#ffffff' }).toColourspace('srgb').toBuffer();
  const flattened = sharp(await liftBackgroundToWhite(opaque));

  // Crop first: trimming after the alpha punch-out would have nothing but
  // transparent pixels at the edges to measure against.
  let trimmed: Buffer;
  try {
    trimmed = await flattened.clone().trim({ background: '#ffffff', threshold: TRIM_THRESHOLD }).toBuffer();
  } catch {
    // `trim` throws on a canvas that's a single flat colour (nothing to crop
    // to) — an all-white or generation-failed image. Fall back to the
    // untrimmed frame rather than fail a request the customer is waiting on.
    trimmed = await flattened.toBuffer();
  }

  // Real AI output rarely uses a pure #ffffff background — 235-244 is
  // typical, sometimes with a faint colour cast — and the live canvas
  // preview's `multiply` blend hides this completely (multiplying by white
  // is a no-op regardless of the pixel's actual alpha), so the defect was
  // invisible there and only showed up in this true-alpha PNG export.
  // Normalising first stretches this specific image's own actual range to
  // fill 0-255, so the fixed WHITE_THRESHOLD/INK_THRESHOLD below reliably
  // separate background from ink whatever tonal range this particular
  // generation happened to produce, rather than leaving a real background
  // stuck at 70-90% opacity because it never quite reached 245.
  const normalised = await sharp(trimmed).normalise().toBuffer();

  const { data, info } = await sharp(normalised)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Luminance-based alpha: dark ink stays opaque, white background drops to
  // zero, and the band between ramps linearly so edges stay smooth rather
  // than acquiring a hard-edged cutout.
  const channels = info.channels; // 4 (RGBA) after ensureAlpha
  for (let i = 0; i < data.length; i += channels) {
    const luminance = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    let alpha: number;
    if (luminance >= WHITE_THRESHOLD) {
      alpha = 0;
    } else if (luminance <= INK_THRESHOLD) {
      alpha = 255;
    } else {
      alpha = Math.round(
        255 * (1 - (luminance - INK_THRESHOLD) / (WHITE_THRESHOLD - INK_THRESHOLD)),
      );
    }
    // Ink is always pure black: the engraving is monochrome, and this stops
    // any stray colour in the AI output (a red bindi, a tinted line) from
    // showing up in previews or the production files.
    data[i] = 0;
    data[i + 1] = 0;
    data[i + 2] = 0;
    data[i + 3] = alpha;
  }

  let source = sharp(data, { raw: { width: info.width, height: info.height, channels } });

  if (options.cropBelowJaw) {
    const box = computeFaceCropBox(data, info.width, info.height, channels, true);
    // A tight, exact rectangle extract — no colour-matching heuristics
    // involved, unlike the earlier `trim` calls above, since the box was
    // already found by direct pixel geometry.
    if (box && (box.left > 0 || box.top > 0 || box.width < info.width || box.height < info.height)) {
      source = source.extract(box);
    }
  }

  const composed = await source.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });

  return {
    buffer: composed.data,
    width: composed.info.width,
    height: composed.info.height,
    contentType: 'image/png',
  };
}
