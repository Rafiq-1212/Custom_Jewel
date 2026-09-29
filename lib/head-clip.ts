/**
 * Cutting a Face Pendant's drawing back to the head. The photo is cut at the
 * jaw before anything is drawn, but the inker still draws a throat, a collar
 * or the side of a neck under it, so the drawing is clipped again on pixels
 * when it comes back (lib/sketch-pipeline.ts, collectInked).
 */

import sharp from 'sharp';
import { roundDilate, roundErode } from './distance-transform';
import { fillHoles } from './silhouette-geometry';
import { inOval } from './image-processing';
import type { Jawline, KeepBox } from './jawline';

/** Width of the head mask carried with a Face Pendant's inking job; see headMask. */
const HEAD_MASK_WIDTH = 256;
/** How far past the head's shape the drawing may reach, as a fraction of its width — room for a line drawn a touch wide. */
const HEAD_MASK_MARGIN = 0.012;
/**
 * Anything of the photo's outline thinner than twice this, as a fraction of
 * its width, is not part of the head's shape: loose strands of hair, wisps
 * blowing out to the side. Kept narrower than a jhumka (about 5%): at 3%
 * a run whose earrings went unboxed lost both of them here. Left in, the drawing inked every one of them and
 * the cut line bulged out round them, so a woman's pendant was the shape of
 * her flyaway hair rather than of her head.
 */
const HEAD_MASK_STRAY = 0.015;
/**
 * A pixel of the cut photo this bright, connected to its border, is
 * background. Not just the white: the flyaway hair round a woman's head,
 * light against a bright sky, was a halo thick enough to survive
 * HEAD_MASK_STRAY at 240, and the cut line bulged round it. At 200 the halo
 * goes and a man's sunlit cheek stays; at 160 his cheek went too.
 */
const HEAD_MASK_WHITE = 200;

/**
 * The shape of the head, from the cut photo: everything that is not the
 * white background, opened to drop loose strands and wisps (HEAD_MASK_STRAY),
 * with each earring's oval added back — a jhumka is about as narrow as a
 * strand — and grown by a small margin. Returned as a tiny PNG in base64 so it
 * can travel inside the inking job's metadata and come back with the result.
 *
 * The photo is cut cleanly at the jaw before anything is drawn, and the trace
 * ends there too — but the inker still drew a man's collar and shirt under
 * his beard. A rule in the prompt had not stopped it, so the drawing is now
 * clipped to the head afterwards, on pixels.
 */
export async function headMask(photo: Buffer, earrings: KeepBox[] = []): Promise<string> {
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
  const stray = Math.round(width * HEAD_MASK_STRAY);
  const shape = roundDilate(roundErode(subject, width, height, stray), width, height, stray);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (earrings.some((b) => inOval({ left: b.left * width, right: b.right * width, top: b.top * height, bottom: b.bottom * height }, x, y))) {
        shape[y * width + x] = 1;
      }
    }
  }
  const grown = roundDilate(shape, width, height, Math.round(width * HEAD_MASK_MARGIN));
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = grown[i] ? 255 : 0;
  return (await sharp(out, { raw: { width, height, channels: 1 } }).png().toBuffer()).toString('base64');
}

/**
 * Where the photo sits in the drawing: photo point (px, py) lands on drawing
 * point (dx, dy), scaled by k, all as fractions of each image's size. The
 * inker is asked to keep the photo's framing and nearly always does — but
 * one run in about fifteen came back drawn twice as large, filling the
 * frame, and the head shape and jaw line, laid on in the photo's framing,
 * cut that face off at the eyes.
 */
export interface Alignment {
  k: number;
  px: number;
  py: number;
  dx: number;
  dy: number;
}

export const ALIGNED: Alignment = { k: 1, px: 0, py: 0, dx: 0, dy: 0 };

/** A drawing whose scale differs from the photo's by less than this fraction is taken to be in the photo's framing. */
const ALIGN_TOLERANCE = 0.15;
/** Width both shapes are compared at. */
const ALIGN_WIDTH = 96;
/** Scales tried either side of the first estimate, and the step between them. */
const ALIGN_SCALE_RANGE = 0.2;
const ALIGN_SCALE_STEP = 0.02;
/** Shifts tried either side of the first estimate, as a fraction of the width. */
const ALIGN_SHIFT_RANGE = 0.08;

/** A shape as a low-resolution mask: dark pixels of `image`, or light ones when `light`. */
async function shapeOf(image: Buffer, light: boolean): Promise<{ mask: Uint8Array; width: number; height: number }> {
  const { data, info } = await sharp(image).greyscale().resize({ width: ALIGN_WIDTH }).raw().toBuffer({ resolveWithObject: true });
  const mask = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) mask[i] = (light ? data[i] >= 128 : data[i] < 160) ? 1 : 0;
  return { mask, width: info.width, height: info.height };
}

/**
 * How the photo sits in `drawing`, found by laying the photo's head shape
 * over the drawing's filled-in shape. A first guess matches their areas and
 * centres; scales and shifts around it are then tried and the one covering
 * most (by intersection over union) is kept. Matching the boxes the two
 * shapes fill was tried first and was thrown by the inker drawing the hair
 * a different width: the lined-up cut still took a cheek. ALIGNED unless the
 * scale found is off by more than ALIGN_TOLERANCE.
 */
export async function alignDrawing(drawing: Buffer, mask: string): Promise<Alignment> {
  const head = await shapeOf(Buffer.from(mask, 'base64'), true);
  const ink = await shapeOf(drawing, false);
  const { width, height } = ink;
  const drawn = fillHoles(roundDilate(ink.mask, width, height, 2), width, height);
  // The mask is stretched to the drawing's frame, as clipToHead lays it on.
  const photo = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      photo[y * width + x] = head.mask[Math.min(head.height - 1, Math.floor((y * head.height) / height)) * head.width + Math.min(head.width - 1, Math.floor((x * head.width) / width))];
    }
  }
  const moments = (m: Uint8Array) => {
    let n = 0;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < m.length; i++) {
      if (!m[i]) continue;
      n++;
      sx += i % width;
      sy += Math.floor(i / width);
    }
    return { n, cx: n ? sx / n : 0, cy: n ? sy / n : 0 };
  };
  const p = moments(photo);
  const d = moments(drawn);
  if (!p.n || !d.n) return ALIGNED;

  // Photo pixel (x, y) lands on drawing pixel (d.cx + (x - p.cx) * k + tx, ...).
  const overlap = (k: number, tx: number, ty: number) => {
    let both = 0;
    let either = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const px = Math.round(p.cx + (x - d.cx - tx) / k);
        const py = Math.round(p.cy + (y - d.cy - ty) / k);
        const inPhoto = px >= 0 && py >= 0 && px < width && py < height && photo[py * width + px] === 1;
        const inDrawn = drawn[y * width + x] === 1;
        if (inPhoto && inDrawn) both++;
        if (inPhoto || inDrawn) either++;
      }
    }
    return either ? both / either : 0;
  };
  const guess = Math.sqrt(d.n / p.n);
  const range = Math.round(width * ALIGN_SHIFT_RANGE);
  let best = { score: overlap(1, p.cx - d.cx, p.cy - d.cy), k: 1, tx: p.cx - d.cx, ty: p.cy - d.cy };
  for (let k = guess * (1 - ALIGN_SCALE_RANGE); k <= guess * (1 + ALIGN_SCALE_RANGE); k += guess * ALIGN_SCALE_STEP) {
    for (let tx = -range; tx <= range; tx += 2) {
      for (let ty = -range; ty <= range; ty += 2) {
        const score = overlap(k, tx, ty);
        if (score > best.score) best = { score, k, tx, ty };
      }
    }
  }
  if (Math.abs(best.k - 1) < ALIGN_TOLERANCE) return ALIGNED;
  console.info(`[sketch] face: the drawing came back ${best.k.toFixed(2)}x the photo's size (overlap ${best.score.toFixed(2)})`);
  // In fractions: photo point (p.cx, p.cy) lands on drawing point (d.cx + tx, d.cy + ty).
  return { k: best.k, px: p.cx / width, py: p.cy / height, dx: (d.cx + best.tx) / width, dy: (d.cy + best.ty) / height };
}

/** A jawline in the photo, moved to where it falls in the drawing. */
export function alignJaw(jaw: Jawline, a: Alignment): Jawline {
  if (a === ALIGNED) return jaw;
  const x = (v: number) => a.dx + (v - a.px) * a.k;
  const y = (v: number) => a.dy + (v - a.py) * a.k;
  return {
    points: jaw.points.map((p) => ({ x: x(p.x), y: y(p.y) })),
    keep: jaw.keep.map((b) => ({ left: x(b.left), top: y(b.top), right: x(b.right), bottom: y(b.bottom) })),
  };
}

/** Whites out every pixel of `image` that falls outside the head mask, laid on where `a` says the photo sits. */
export async function clipToHead(image: Buffer, mask: string, a: Alignment = ALIGNED): Promise<Buffer> {
  const { data, info } = await sharp(image).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const scaledWidth = Math.max(1, Math.round(width * a.k));
  const scaledHeight = Math.max(1, Math.round(height * a.k));
  const ox = Math.round((a.dx - a.px * a.k) * width);
  const oy = Math.round((a.dy - a.py * a.k) * height);
  const scaled = await sharp(Buffer.from(mask, 'base64')).resize(scaledWidth, scaledHeight, { fit: 'fill' }).greyscale().raw().toBuffer();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const mx = x - ox;
      const my = y - oy;
      const inside = mx >= 0 && my >= 0 && mx < scaledWidth && my < scaledHeight && scaled[my * scaledWidth + mx] >= 128;
      if (!inside) data[y * width + x] = 255;
    }
  }
  return sharp(data, { raw: { width, height, channels: 1 } }).png().toBuffer();
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
 * Past each end of the line the cut holds the end's height for JAW_CUT_LEVEL
 * of the width — the ear lobe and an earring hanging from it — then curves
 * up around the head, rising by (distance past that)² / (this fraction of
 * the width). Rising straight from the end clipped a woman's ear lobe. The pendant is the shape of the face — hair falling past the
 * jaw to the shoulders, cut on a slant, made a tail on the cut line. Carried
 * on as a curve rather than stopped at the end, which left a vertical cliff
 * in the sideburn under a man's ear.
 */
const JAW_CUT_RISE = 0.1;
const JAW_CUT_LEVEL = 0.05;

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
 * smoothed into one curve and carried on past the line's ends, curving up
 * around the head (JAW_CUT_RISE), so the piece ends in the shape of the
 * face rather than of the hair. Earrings hanging below the lobe stay:
 * the oval in each earring's box, since the box itself kept the hair behind
 * a jhumka as a black rectangle.
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
  const from = 0;
  const to = width - 1;
  const rise = width * JAW_CUT_RISE;
  const level = width * JAW_CUT_LEVEL;
  const past = (d: number) => Math.max(0, d - level) ** 2 / rise;
  for (let x = from; x < first; x++) raw[x] = raw[first] - past(first - x);
  for (let x = last + 1; x <= to; x++) raw[x] = raw[last] - past(x - last);
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
      if (kept.some((k) => inOval(k, x, y))) continue;
      data[y * width + x] = 255;
    }
  }
  return sharp(data, { raw: { width, height, channels: 1 } }).png().toBuffer();
}
