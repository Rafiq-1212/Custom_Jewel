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
 * shortens that crop to end at the jaw, as a deterministic backstop for
 * when Gemini's framing prompt alone doesn't keep the neck out — see
 * `computeFaceCropBox` below.
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
   * Face Pendant's prompt (lib/gemini.ts) asks Gemini to end the artwork at
   * the jaw, but a prompt is a request, not a guarantee — some generations
   * still include a neck (sometimes trailing into shoulders). This is the
   * deterministic backstop: found and removed here, from the alpha mask's
   * own geometry, rather than by asking Gemini again (which would break the
   * "Gemini called exactly once" rule) or relying on the prompt alone (which
   * verifiably isn't reliable enough by itself). See `computeFaceCropBox`.
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
 * Crop the AI's generous white margin to the actual artwork, then convert
 * every near-white pixel to transparent, ramping alpha across the threshold
 * band so anti-aliased line edges don't get a hard, jagged cutout.
 */
export async function makeTransparentMasterSketch(
  input: Buffer,
  options: MasterSketchOptions = {},
): Promise<MasterSketch> {
  const flattened = sharp(input).flatten({ background: '#ffffff' }).toColourspace('srgb');

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
