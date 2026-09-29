/**
 * Cutting a Face Pendant's drawing back to the head. The photo is cut at the
 * jaw before anything is drawn, but the inker still draws a throat, a collar
 * or the side of a neck under it, so the drawing is clipped again on pixels
 * when it comes back (lib/sketch-pipeline.ts, collectInked).
 */

import sharp from 'sharp';
import { roundDilate } from './distance-transform';
import type { Jawline } from './jawline';

/** Width of the head mask carried with a Face Pendant's inking job; see headMask. */
const HEAD_MASK_WIDTH = 256;
/** How far past the photo's own head outline the drawing may reach, as a fraction of its width — room for flyaway hair and a line drawn a touch wide. */
const HEAD_MASK_MARGIN = 0.02;
/** A pixel of the cut photo this bright, connected to its border, is background. */
const HEAD_MASK_WHITE = 240;

/**
 * Where the head is, from the cut photo: everything that is not the white
 * background, grown by a small margin. Returned as a tiny PNG in base64 so it
 * can travel inside the inking job's metadata and come back with the result.
 *
 * The photo is cut cleanly at the jaw before anything is drawn, and the trace
 * ends there too — but the inker still drew a man's collar and shirt under
 * his beard. A rule in the prompt had not stopped it, so the drawing is now
 * clipped to the head afterwards, on pixels.
 */
export async function headMask(photo: Buffer): Promise<string> {
  const { data, info } = await sharp(photo)
    .flatten({ background: '#ffffff' })
    .resize({ width: HEAD_MASK_WIDTH })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  const n = width * height;
  const background = new Uint8Array(n);
  const stack = new Int32Array(n);
  let top = 0;
  const claim = (i: number) => {
    if (!background[i] && data[i] >= HEAD_MASK_WHITE) {
      background[i] = 1;
      stack[top++] = i;
    }
  };
  for (let x = 0; x < width; x++) { claim(x); claim(n - width + x); }
  for (let y = 0; y < height; y++) { claim(y * width); claim(y * width + width - 1); }
  while (top) {
    const i = stack[--top];
    const x = i % width;
    if (x > 0) claim(i - 1);
    if (x < width - 1) claim(i + 1);
    if (i >= width) claim(i - width);
    if (i < n - width) claim(i + width);
  }
  const subject = new Uint8Array(n);
  for (let i = 0; i < n; i++) subject[i] = background[i] ? 0 : 1;
  const grown = roundDilate(subject, width, height, Math.round(width * HEAD_MASK_MARGIN));
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = grown[i] ? 255 : 0;
  return (await sharp(out, { raw: { width, height, channels: 1 } }).png().toBuffer()).toString('base64');
}

/** Whites out every pixel of `image` that falls outside the head mask. The drawing and the photo share their framing, so the mask is simply stretched to fit. */
export async function clipToHead(image: Buffer, mask: string): Promise<Buffer> {
  const { data, info } = await sharp(image).greyscale().raw().toBuffer({ resolveWithObject: true });
  const keep = await sharp(Buffer.from(mask, 'base64')).resize(info.width, info.height, { fit: 'fill' }).greyscale().raw().toBuffer();
  for (let i = 0; i < data.length; i++) if (keep[i] < 128) data[i] = 255;
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 1 } }).png().toBuffer();
}

/** Left under the jawline in the drawing, as a fraction of its height, whatever is drawn there. */
const DRAWING_JAW_MARGIN = 0.006;
/**
 * How far below the jawline a beard may carry on, as a fraction of the
 * drawing's height. The traced line is the model's guess at the bottom of
 * the beard and the inker draws its own beard a little lower in places; a
 * hard cut on the line sliced a man's goatee off in a straight edge.
 */
const DRAWING_BEARD_REACH = 0.035;
/** Half-width of the window ink density is measured over, as a fraction of the drawing's width. */
const BEARD_WINDOW = 0.012;
/**
 * Ink coverage that counts as beard. Stubble and a goatee are a mass of
 * strokes, well over this; a throat line, a collar edge or the side of a
 * neck is one stroke crossing an otherwise empty window, well under it.
 */
const BEARD_DENSITY = 0.4;
/**
 * How far below the traced line the drawn jaw outline is looked for, as a
 * fraction of the drawing's height. The inker draws a solid outline along
 * the jaw, and on a man's photo it ran up to 2% below the traced line near
 * his ear: cut on the line, the outline went and the stubble above it was
 * left sliced open. See findDrawnJaw.
 */
const DRAWN_JAW_REACH = 0.04;
/** How far above the traced line the outline is looked for too, as a fraction of the height: it can sit right on the line or a touch above it. */
const DRAWN_JAW_ABOVE = 0.01;
/**
 * Cost per column of each pixel the outline sits further down, as a fraction
 * of one inked pixel. The shading under a woman's chin is drawn as lines
 * parallel to her jaw, as continuous as the outline itself; without a
 * preference for the higher line the search followed the lowest of them and
 * kept her throat.
 */
const DRAWN_JAW_DEPTH = 0.004;
/** Cost of the searched outline moving one pixel against the traced line, per column; keeps it a smooth curve parallel to the jaw. */
const DRAWN_JAW_BEND = 0.35;
/** The drawn outline has to be at least this solid (fraction of its columns inked, over a short stretch) to be cut under. */
const DRAWN_JAW_SOLID = 0.7;

/**
 * The cut is averaged over this half-width, as a fraction of the drawing's
 * width, so it runs as one smooth curve. Decided column by column it jumped
 * wherever the beard test flipped, and left square notches in the beard.
 */
const JAW_CUT_SMOOTHING = 0.015;
/**
 * Past each end of the line the cut carries on for this fraction of the
 * width, falling away at JAW_CUT_TAPER_SLOPE, and then stops. Stopping dead
 * at the end left a vertical cliff in the sideburn under a man's ear — the
 * step in the jaw that showed in the cut line. The fall is steep enough to
 * pass under an ear lobe the inker drew a little low, and short enough to
 * leave a woman's hair falling past her jaw alone.
 */
const JAW_CUT_TAPER = 0.04;
const JAW_CUT_TAPER_SLOPE = 1.5;

/**
 * The jaw outline the inker drew under the traced line, as the row just
 * below it in each column (NaN where there is no solid outline).
 *
 * Found as the darkest path that runs alongside the traced line, a dynamic
 * programme over the offset below it: a drawn outline is one continuous
 * stroke and scores in every column, stubble is broken strokes and scores
 * in some, and a line down the neck crosses the band in a few columns and
 * then leaves it, which the bend cost will not follow.
 */
function findDrawnJaw(ink: (x: number, y: number) => boolean, lineY: Float64Array, first: number, last: number, height: number): Float64Array {
  const above = Math.round(height * DRAWN_JAW_ABOVE);
  const band = Math.max(4, above + Math.round(height * DRAWN_JAW_REACH));
  const columns = last - first + 1;
  const score = new Float64Array(columns * band);
  const from = new Int8Array(columns * band);
  const hit = (x: number, o: number) => (ink(x, Math.round(lineY[x]) + o - above) ? 1 : 0);
  const gain = (x: number, o: number) => hit(x, o) - Math.max(0, o - above) * DRAWN_JAW_DEPTH;
  for (let o = 0; o < band; o++) score[o] = gain(first, o);
  for (let c = 1; c < columns; c++) {
    for (let o = 0; o < band; o++) {
      let best = -Infinity;
      let step = 0;
      for (let d = -1; d <= 1; d++) {
        const q = o + d;
        if (q < 0 || q >= band) continue;
        const value = score[(c - 1) * band + q] - (d ? DRAWN_JAW_BEND : 0);
        if (value > best) {
          best = value;
          step = d;
        }
      }
      score[c * band + o] = best + gain(first + c, o);
      from[c * band + o] = step;
    }
  }
  const path = new Int32Array(columns);
  let end = 0;
  for (let o = 1; o < band; o++) if (score[(columns - 1) * band + o] > score[(columns - 1) * band + end]) end = o;
  for (let c = columns - 1; c >= 0; c--) {
    path[c] = end;
    end += from[c * band + end];
  }

  // Only a solid run is an outline; below it, the stroke's own thickness.
  const out = new Float64Array(lineY.length).fill(Number.NaN);
  const stretch = Math.max(3, Math.round(band / 2));
  for (let c = 0; c < columns; c++) {
    let inked = 0;
    let n = 0;
    for (let k = Math.max(0, c - stretch); k <= Math.min(columns - 1, c + stretch); k++, n++) inked += hit(first + k, path[k]);
    if (inked / n < DRAWN_JAW_SOLID) continue;
    const x = first + c;
    let y = Math.round(lineY[x]) + path[c] - above;
    while (y < height && ink(x, y)) y++;
    out[x] = y;
  }
  return out;
}

/**
 * Whites out the drawing below the jawline the photo was cut along — the
 * chin, or the bottom of the beard. The head mask alone follows the photo's
 * feathered cut and a margin past it, and the inker drew a throat, a collar
 * edge and the start of the neck into that band on a bearded man and on a
 * woman. Just under the line, ink that is still as dense as a beard is kept
 * down to where the beard thins out; lone strokes are not. The cut is then
 * smoothed into one curve and tapered off past the line's ends, where the
 * head mask takes over: it stops the neck at the ear lobe and keeps a
 * woman's hair falling below her jaw. Earrings hanging below the lobe stay.
 */
export async function clipBelowJaw(image: Buffer, jaw: Jawline): Promise<Buffer> {
  const { data, info } = await sharp(image).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;

  // Summed-area table of ink, for the density of any window in O(1).
  const sums = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += data[y * width + x] < 128 ? 1 : 0;
      sums[(y + 1) * (width + 1) + x + 1] = sums[y * (width + 1) + x + 1] + row;
    }
  }
  const r = Math.max(2, Math.round(width * BEARD_WINDOW));
  const density = (x: number, y: number) => {
    const x0 = Math.max(0, x - r);
    const y0 = Math.max(0, y - r);
    const x1 = Math.min(width, x + r + 1);
    const y1 = Math.min(height, y + r + 1);
    const ink = sums[y1 * (width + 1) + x1] - sums[y0 * (width + 1) + x1] - sums[y1 * (width + 1) + x0] + sums[y0 * (width + 1) + x0];
    return ink / ((x1 - x0) * (y1 - y0));
  };

  const points = jaw.points.map((p) => ({ x: p.x * (width - 1), y: p.y * (height - 1) }));
  const margin = height * DRAWING_JAW_MARGIN;
  const reach = height * DRAWING_BEARD_REACH;
  const first = Math.max(0, Math.ceil(points[0].x));
  const last = Math.min(width - 1, Math.floor(points[points.length - 1].x));
  if (last < first) return image;

  const lineY = new Float64Array(width);
  let segment = 0;
  for (let x = first; x <= last; x++) {
    while (segment < points.length - 2 && points[segment + 1].x < x) segment++;
    const a = points[segment];
    const b = points[segment + 1];
    lineY[x] = a.y + (b.y - a.y) * (b.x === a.x ? 0 : (x - a.x) / (b.x - a.x));
  }
  const drawn = findDrawnJaw((x, y) => y >= 0 && y < height && data[y * width + x] < 128, lineY, first, last, height);

  // Where the cut starts in each column along the line: under the drawn
  // outline, or under the beard, whichever is lower.
  const raw = new Float64Array(width);
  for (let x = first; x <= last; x++) {
    let from = Math.max(0, Math.ceil(lineY[x] + margin));
    while (from < height && from < lineY[x] + reach && density(x, from) >= BEARD_DENSITY) from++;
    raw[x] = Number.isNaN(drawn[x]) ? from : Math.max(from, drawn[x] + 1);
  }

  // Tapered past both ends, then averaged into one curve.
  const taper = Math.round(width * JAW_CUT_TAPER);
  const from = Math.max(0, first - taper);
  const to = Math.min(width - 1, last + taper);
  for (let x = from; x < first; x++) raw[x] = raw[first] + (first - x) * JAW_CUT_TAPER_SLOPE;
  for (let x = last + 1; x <= to; x++) raw[x] = raw[last] + (x - last) * JAW_CUT_TAPER_SLOPE;
  const s = Math.max(1, Math.round(width * JAW_CUT_SMOOTHING));
  const kept = jaw.keep.map((b) => ({ left: b.left * width, right: b.right * width, top: b.top * height, bottom: b.bottom * height }));
  for (let x = from; x <= to; x++) {
    let total = 0;
    let n = 0;
    for (let k = Math.max(from, x - s); k <= Math.min(to, x + s); k++) {
      total += raw[k];
      n++;
    }
    for (let y = Math.max(0, Math.ceil(total / n)); y < height; y++) {
      if (kept.some((k) => x >= k.left && x <= k.right && y >= k.top && y <= k.bottom)) continue;
      data[y * width + x] = 255;
    }
  }
  return sharp(data, { raw: { width, height, channels: 1 } }).png().toBuffer();
}
