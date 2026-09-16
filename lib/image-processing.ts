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
 * `computeFaceCropBox` above is not the right test here. It looks for a
 * cylindrical neck plateau because it has to survive being handed a picture
 * that is *already* head-only, where cutting at the jaw would shave the
 * chin. This photo is different: it still has the body, and a neck that
 * flares straight into shoulders never forms that plateau. So the rule here
 * is the simpler one — cut at the jaw, but only once there is clearly a body
 * below it to cut off.
 */
/** Shoulders have to be at least this much wider than the head to count as a body. */
const SHOULDER_FLARE_RATIO = 1.1;
/** The neck has to be at least this much narrower than the shoulders to count as a neck. */
const NECK_PINCH_RATIO = 0.85;
/** Rows within this much of the narrowest one are still "the neck". */
const NECK_TOLERANCE = 1.05;

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

  // The head's widest point (hair and ears), searched in the upper part of
  // the subject so a pair of shoulders can never be taken for the head.
  const peakSearchEnd = topY + Math.round((bottomY - topY + 1) * 0.5);
  let peakWidth = 0;
  let peakY = topY;
  for (let y = topY; y <= peakSearchEnd; y++) {
    if (width[y] > peakWidth) {
      peakWidth = width[y];
      peakY = y;
    }
  }
  if (peakWidth === 0) return photo;

  // The shoulders: the widest row low down. A picture that is already
  // head-only has nothing wider than the head there, and is left alone.
  let shoulderWidth = 0;
  let shoulderY = -1;
  for (let y = peakSearchEnd + 1; y <= bottomY; y++) {
    if (width[y] > shoulderWidth) {
      shoulderWidth = width[y];
      shoulderY = y;
    }
  }
  if (shoulderY === -1 || shoulderWidth < peakWidth * SHOULDER_FLARE_RATIO) return photo;

  // The neck is the waist between the two: the narrowest row in between.
  // Measured this way rather than as "the first row narrower than the jaw",
  // because on a head turned to one side the neck is barely narrower than
  // the head itself (measured: 259 px against a 290 px head), while it is
  // always clearly narrower than the shoulders below it.
  let neckWidth = Infinity;
  for (let y = peakY + 1; y < shoulderY; y++) {
    if (width[y] > 0 && width[y] < neckWidth) neckWidth = width[y];
  }
  if (neckWidth === Infinity || neckWidth > shoulderWidth * NECK_PINCH_RATIO) return photo;

  // The LAST row of that waist, not the first: the first one can still be
  // the bottom of a beard, and leaving a little neck behind costs nothing —
  // `computeFaceCropBox` trims it off the finished artwork later.
  let neckY = -1;
  for (let y = peakY + 1; y < shoulderY; y++) {
    if (width[y] > 0 && width[y] <= neckWidth * NECK_TOLERANCE) neckY = y;
  }
  if (neckY === -1) return photo;

  // Painted white rather than cropped away, so the head keeps the natural
  // silhouette of its own chin and beard instead of ending on a straight
  // cut, exactly as it did when the photo-edit prompt still did this.
  for (let y = neckY + 1; y < info.height; y++) {
    data.fill(255, y * info.width * info.channels, (y + 1) * info.width * info.channels);
  }

  console.info(`[sketch] whited out the body below the neck (row ${neckY} of ${info.height})`);
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
