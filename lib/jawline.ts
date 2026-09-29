/**
 * Where the head ends and the neck begins, asked of a model that can see.
 *
 * Face Pendant has to end at the jaw. Finding the jaw from pixels alone was
 * tried at length (lib/image-processing.ts, `cropPhotoToHead`) and only ever
 * worked for one kind of photo: it needs shoulders in the frame to find the
 * body, and a full beard to find the jaw. A customer photo cropped at the
 * neck has no shoulders, and a goatee or a clean face has no beard line, so
 * the neck and collar stayed in the pendant.
 *
 * So the jaw is located by a TEXT call instead: the model is shown the photo
 * and returns the lower outline of the head as coordinates. It never returns
 * an image, so it cannot re-pose or redraw anyone, and it costs a fraction
 * of a cent against 7-15 cents for an image call. Verified on a clean face
 * cropped at the neck and on bearded, turned heads: the line runs from under
 * one ear lobe, along the jaw or the bottom of the beard, to under the other.
 *
 * Everything here is advisory: on any failure or implausible answer this
 * returns null and the pixel heuristics are used instead.
 */

import sharp from 'sharp';
import { Type } from '@google/genai';
import { generateJsonFromImage } from './gemini';

if (typeof window !== 'undefined') {
  throw new Error('lib/jawline.ts was imported into a browser bundle. This module is server-only.');
}

/** A point on the photo, as fractions of its width and height. */
export interface JawPoint {
  x: number;
  y: number;
}

/** A box on the photo, as fractions of its width and height. */
export interface KeepBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Jawline {
  /** The lower outline of the head, left to right. */
  points: JawPoint[];
  /**
   * Earrings that hang below the ear lobe. They sit under the cut, which
   * holds the height of the lobe beside the jaw, and would be sliced off a
   * woman's portrait without this.
   */
  keep: KeepBox[];
}

const JAW_PROMPT = `This photo shows one person's head. Everything below is on a 0-1000 scale (y down, x right).

Return "head": the bounding box [ymin, xmin, ymax, xmax] of the WHOLE head — the top of the hair down to the lowest point of the chin (or of the beard, if there is one), and the outer edge of one ear or cheek across to the other. Nothing below the chin goes in it.

Return "jaw": 9 to 15 points, in order from the left side of the image to the right, tracing the lower outline of the head — the line where the head ends and the neck begins. Start just under one ear lobe, follow the edge of the jaw (or the bottom edge of the beard, if the beard hangs lower than the jaw) down around the chin, and back up to just under the other ear lobe. If an ear is hidden, start where the jaw meets the hairline on that side. The line has to reach out to BOTH sides of the head: it runs from ear to ear, not from cheek to cheek, and its lowest point is the bottom of the chin, not the crease under the lip. On a baby, a child or a face seen from above the chin is soft and tucked in — follow the bottom edge of the cheeks and chin all the same.
Also return "ear_lobes": the lowest point [y, x] of each ear lobe that is visible (zero, one or two points).
Also return "beard": true if there is any beard, goatee or stubble on the chin or jaw, false for a clean-shaven chin.
Also return "earrings": one bounding box [ymin, xmin, ymax, xmax] on the same 0-1000 scale for each earring that hangs below the ear lobe, or an empty list if there are none.`;

const JAW_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    head: { type: Type.ARRAY, items: { type: Type.NUMBER } },
    jaw: { type: Type.ARRAY, items: { type: Type.ARRAY, items: { type: Type.NUMBER } } },
    ear_lobes: { type: Type.ARRAY, items: { type: Type.ARRAY, items: { type: Type.NUMBER } } },
    earrings: { type: Type.ARRAY, items: { type: Type.ARRAY, items: { type: Type.NUMBER } } },
    beard: { type: Type.BOOLEAN },
  },
  required: ['head', 'jaw', 'ear_lobes', 'earrings', 'beard'],
};

const MIN_POINTS = 5;
/**
 * The traced line has to reach across this much of the head's own width, or
 * it is not a jawline. Verified on a baby photographed from above: the model
 * traced a curve from one cheek to the other, under the lower lip, covering
 * less than half the head. Cutting below that took the chin and both sides
 * of the face off — the whole jaw, as reported. The head's box, asked for in
 * the same breath, was accurate on every photo tried, so it is used both to
 * catch a line like that and to cut in its place.
 *
 * The bar is set against the head's box, which includes the HAIR, and no
 * jawline spans a head's hair: measured, a good line on a woman with her
 * hair down covered 64% of the box and a good one on a bearded man 80%,
 * against the bad line's 45%.
 */
const MIN_HEAD_SPAN = 0.35;
/** The line's lowest point has to be at least this far down the head, or it is across the face rather than under it. */
const MIN_CHIN_DEPTH = 0.6;
/**
 * How far down the head the line's two ENDS are pushed if they sit higher.
 * Outside the line's span the cut holds the height of the nearer end, so an
 * end up at eye level takes the side of the head off with it — that is what
 * removed a baby's whole jaw. Clamped rather than rejected, because the
 * depth is borderline on a baby (its ears sit low on a big cranium) and a
 * line that flips between accepted and rejected from one run to the next is
 * worse than one that is always nudged into a safe place.
 */
const MIN_END_DEPTH = 0.6;
/** A jaw narrower than this fraction of the photo is not a jaw. */
const MIN_SPAN = 0.08;
/** The chin cannot sit in the top fifth of the photo. */
const MIN_CHIN_Y = 0.2;
/** An "earring" bigger than this fraction of the photo on either side is not an earring, and is ignored. */
const MAX_EARRING = 0.25;
/** A lobe further than this from the traced line's end (fraction of width) belongs to something else. */
const MAX_LOBE_DISTANCE = 0.2;

function isPair(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number' && Number.isFinite(n));
}

/** How far above the traced chin its real lower edge is looked for, as a fraction of the traced line's width. */
const CHIN_SEARCH = 0.22;
/** Rows either side of a candidate edge whose brightness is compared, as a fraction of the line's width: a soft chin fades into its shadow over about this much. */
const CHIN_EDGE_SPAN = 0.06;
/** Columns either side of the chin's lowest point that are measured, as a fraction of the line's width; the edge runs level across them. */
const CHIN_EDGE_BAND = 0.08;
/** How square the chin-shaped floor is: 2 is a parabola from lobe to chin, higher keeps the corners of the jaw fuller. */
const CHIN_FLOOR_SHAPE = 3;
/** The step from lit chin to the shadow under it has to be at least this much darker (0-255) to be trusted. */
const CHIN_EDGE_MIN = 15;

/**
 * Raises a clean-shaven jaw line to the chin's own lower edge.
 *
 * Asked for the bottom of the chin, the model traced a woman's full chin
 * along the bottom of the shadow under it — on her neck, 3% of the photo
 * below the chin itself — however the prompt put it. The band of neck kept
 * by that traced as a black crescent, and the drawing gave her a heavier,
 * longer chin than she has. The chin's edge is plain in the pixels, though:
 * lit skin above, shadow below. It is measured in a strip across the lowest
 * point of the line, where it runs level, as the sharpest step from light
 * to dark above the traced point, and no point of the line is left below
 * a chin-shaped floor through it. The edge is found in the photo itself, so it lands in the same place
 * however the model's guess varies.
 *
 * Not on a beard: its top edge, below a lit cheek, is exactly such a step
 * and raising the line to it would shave the beard off.
 */
async function raiseToChinEdge(photo: Uint8Array, points: JawPoint[]): Promise<void> {
  const { data, info } = await sharp(photo).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const first = points[0].x * width;
  const last = points[points.length - 1].x * width;
  const span = last - first;
  const chin = points.reduce((low, p) => (p.y > low.y ? p : low));
  const cx = chin.x * width;
  const traced = Math.round(chin.y * height);
  const search = Math.round(span * CHIN_SEARCH);
  const k = Math.max(2, Math.round(span * CHIN_EDGE_SPAN));
  const x0 = Math.max(0, Math.round(cx - span * CHIN_EDGE_BAND));
  const x1 = Math.min(width - 1, Math.round(cx + span * CHIN_EDGE_BAND));

  const rows = new Float64Array(traced + k + 2);
  for (let y = Math.max(0, traced - search - k); y < rows.length; y++) {
    let total = 0;
    for (let x = x0; x <= x1; x++) total += data[Math.min(height - 1, y) * width + x];
    rows[y] = total / (x1 - x0 + 1);
  }
  let best = 0;
  let edge = traced;
  for (let y = traced; y >= Math.max(k, traced - search); y--) {
    let drop = 0;
    for (let j = 1; j <= k; j++) drop += rows[y - j] - rows[y + j];
    drop /= k;
    if (drop > best) {
      best = drop;
      edge = y;
    }
  }
  if (best < CHIN_EDGE_MIN || edge >= traced) return;
  // A floor, not a lift: nothing of a face hangs below the bottom of its
  // chin, so every point below it comes up to it, and points already above
  // it stay where they were traced. Lifting the line as a whole pulled one
  // run into a cheek and dented another into a W. The floor is shaped like
  // a chin, lowest at the edge and rising in a U to each end of the line:
  // flat, it gave her a square chin.
  const bottom = edge / height;
  const left = points[0];
  const right = points[points.length - 1];
  console.info(`[sketch] clean-shaven chin: raised the chin ${((100 * (traced - edge)) / height).toFixed(1)}% of the photo to its own edge (step ${best.toFixed(0)})`);
  for (const p of points) {
    const end = p.x < chin.x ? left : right;
    const reach = Math.abs(end.x - chin.x);
    const t = reach > 0 ? Math.min(1, Math.abs(p.x - chin.x) / reach) : 0;
    const floor = bottom - Math.max(0, bottom - end.y) * t ** CHIN_FLOOR_SHAPE;
    if (p.y > floor) p.y = floor;
  }
}

const EARRING_PROMPT = `This is a close-up of one person's head, cut from a larger photo. Everything below is on a 0-1000 scale of THIS image (y down, x right).
Return "earrings": one bounding box [ymin, xmin, ymax, xmax] for each earring that hangs below an ear lobe — a jhumka, a drop, a hoop — covering the whole earring from the lobe to its lowest bead or bell, or an empty list if there are none. Look closely at both ears, including one partly hidden by hair.`;

const EARRING_SCHEMA = {
  type: Type.OBJECT,
  properties: { earrings: { type: Type.ARRAY, items: { type: Type.ARRAY, items: { type: Type.NUMBER } } } },
  required: ['earrings'],
};

/** Width the close-up of the head is enlarged to before the earrings are looked for. */
const EARRING_CLOSE_UP_WIDTH = 768;
/** Room kept round the head in that close-up, as fractions of the head's size: out past the ears, and down to where a long jhumka ends. */
const EARRING_CLOSE_UP_SIDES = 0.2;
const EARRING_CLOSE_UP_BELOW = 0.35;

type Box = { left: number; top: number; right: number; bottom: number };

/** Earring boxes from a model's answer, on the 0-1000 scale of `frame` (fractions of the photo), as fractions of the photo. */
function readEarrings(value: unknown, frame: Box): KeepBox[] {
  if (!Array.isArray(value)) return [];
  const w = frame.right - frame.left;
  const h = frame.bottom - frame.top;
  return value
    .filter((b): b is number[] => Array.isArray(b) && b.length === 4 && b.every((n) => typeof n === 'number' && Number.isFinite(n)))
    .map(([top, left, bottom, right]) => ({
      left: frame.left + (left / 1000) * w,
      top: frame.top + (top / 1000) * h,
      right: frame.left + (right / 1000) * w,
      bottom: frame.top + (bottom / 1000) * h,
    }))
    .filter((b) => b.right > b.left && b.bottom > b.top && b.right - b.left < MAX_EARRING && b.bottom - b.top < MAX_EARRING);
}

/** The earrings in a close-up of `head` (fractions of the photo), or none if that could not be read. */
async function closeUpEarrings(photo: Uint8Array, head: Box): Promise<KeepBox[]> {
  try {
    const { width = 0, height = 0 } = await sharp(photo).metadata();
    const hw = head.right - head.left;
    const hh = head.bottom - head.top;
    const frame = {
      left: Math.max(0, head.left - hw * EARRING_CLOSE_UP_SIDES),
      top: Math.max(0, head.top),
      right: Math.min(1, head.right + hw * EARRING_CLOSE_UP_SIDES),
      bottom: Math.min(1, head.bottom + hh * EARRING_CLOSE_UP_BELOW),
    };
    const left = Math.floor(frame.left * width);
    const top = Math.floor(frame.top * height);
    const cropWidth = Math.min(width - left, Math.ceil((frame.right - frame.left) * width));
    const cropHeight = Math.min(height - top, Math.ceil((frame.bottom - frame.top) * height));
    if (cropWidth < 8 || cropHeight < 8) return [];
    const crop = await sharp(photo).extract({ left, top, width: cropWidth, height: cropHeight }).resize({ width: EARRING_CLOSE_UP_WIDTH }).png().toBuffer();
    const answer = await generateJsonFromImage({ prompt: EARRING_PROMPT, image: { bytes: crop, mimeType: 'image/png' }, schema: EARRING_SCHEMA });
    return readEarrings((answer as { earrings?: unknown } | null)?.earrings, {
      left: left / width,
      top: top / height,
      right: (left + cropWidth) / width,
      bottom: (top + cropHeight) / height,
    });
  } catch (error) {
    console.info(`[sketch] close-up of the ears could not be read, keeping the first look: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/**
 * The jawline of the one person in `photo`, left to right, or null when the
 * model's answer cannot be trusted.
 */
export async function findJawline(photo: Uint8Array, mimeType: string): Promise<Jawline | null> {
  let answer: unknown;
  try {
    answer = await generateJsonFromImage({ prompt: JAW_PROMPT, image: { bytes: photo, mimeType }, schema: JAW_SCHEMA });
  } catch (error) {
    console.info(`[sketch] jawline lookup failed, falling back to the pixel cut: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  const raw = (answer as { jaw?: unknown } | null)?.jaw;
  if (!Array.isArray(raw)) return null;

  const points = raw
    .filter(isPair)
    .map(([y, x]) => ({ x: x / 1000, y: y / 1000 }))
    .filter((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)
    .sort((a, b) => a.x - b.x);

  if (points.length < MIN_POINTS) return null;
  if (points[points.length - 1].x - points[0].x < MIN_SPAN) return null;
  if (Math.max(...points.map((p) => p.y)) < MIN_CHIN_Y) return null;

  // The head's box, used to judge the traced line and to replace it when it
  // is wrong. A line that does not reach across the head, or whose lowest
  // point is not near the bottom of it, is a line drawn across the face.
  const box = (answer as { head?: unknown }).head;
  const head =
    Array.isArray(box) && box.length === 4 && box.every((n) => typeof n === 'number' && Number.isFinite(n))
      ? { top: box[0] / 1000, left: box[1] / 1000, bottom: box[2] / 1000, right: box[3] / 1000 }
      : null;
  if (head && head.bottom > head.top && head.right > head.left) {
    const headWidth = head.right - head.left;
    const headHeight = head.bottom - head.top;
    const span = points[points.length - 1].x - points[0].x;
    const depth = (Math.max(...points.map((p) => p.y)) - head.top) / headHeight;
    const ends = (Math.min(points[0].y, points[points.length - 1].y) - head.top) / headHeight;
    console.info(
      `[sketch] jawline covers ${((100 * span) / headWidth).toFixed(0)}% of the head's width, reaches ${(100 * depth).toFixed(0)}% down it, ends at ${(100 * ends).toFixed(0)}%`,
    );

    // Outside the line's span the cut holds the height of the nearer end, so
    // an end that sits high takes the side of the head with it. Rather than
    // throw the whole line away for that, the ends are pushed down to a
    // depth that cannot cut into the head. A line that already ends under
    // the ear lobes is untouched; one that ends up on a cheek is pulled
    // down to the jaw's level, which still clears the neck beside it.
    const floor = head.bottom - headHeight * (1 - MIN_END_DEPTH);
    for (const end of [points[0], points[points.length - 1]]) {
      if (end.y < floor) end.y = floor;
    }

    if (span < headWidth * MIN_HEAD_SPAN || depth < MIN_CHIN_DEPTH) {
      console.info(
        `[sketch] the traced jawline covers ${((100 * span) / headWidth).toFixed(0)}% of the head and sits ${(100 * depth).toFixed(0)}% down it; cutting straight under the head instead`,
      );
      return {
        points: [
          { x: head.left, y: head.bottom },
          { x: head.right, y: head.bottom },
        ],
        keep: [],
      };
    }
  }

  // "Just under the ear lobe" is the vaguest part of the traced line: asked
  // twice about one photo, its ends moved by 7-11% of the photo's height,
  // and an end that lands low leaves a wedge of neck under the ear, which
  // is drawn as a line hanging off it. The lobe itself is a landmark the
  // model places far more steadily, so each end is snapped to its lobe.
  const lobes = (answer as { ear_lobes?: unknown }).ear_lobes;
  if (Array.isArray(lobes)) {
    for (const lobe of lobes.filter(isPair).map(([y, x]) => ({ x: x / 1000, y: y / 1000 }))) {
      if (lobe.x < 0 || lobe.x > 1 || lobe.y < 0 || lobe.y > 1) continue;
      const first = points[0];
      const last = points[points.length - 1];
      const leftSide = Math.abs(lobe.x - first.x) <= Math.abs(lobe.x - last.x);
      const end = leftSide ? first : last;
      if (Math.abs(lobe.x - end.x) > MAX_LOBE_DISTANCE) continue;
      // Never lower an end: a lobe below the traced end would keep more neck, not less.
      if (lobe.y >= end.y) continue;
      if (leftSide) {
        if (lobe.x < first.x) points.unshift(lobe);
        else first.y = lobe.y;
      } else if (lobe.x > last.x) points.push(lobe);
      else last.y = lobe.y;
    }
  }

  if ((answer as { beard?: unknown }).beard === false) await raiseToChinEdge(photo, points);

  // The earrings are looked for again in a close-up of the head, and both
  // answers kept. In a half-length photo a jhumka is a few pixels wide, and
  // for one woman two answers in a row came back with none; a Face Pendant
  // loses whatever earring is not boxed.
  const keep = readEarrings((answer as { earrings?: unknown }).earrings, { left: 0, top: 0, right: 1, bottom: 1 });
  const found = head ? await closeUpEarrings(photo, head) : [];
  for (const box of found) {
    const same = keep.find((k) => box.left < k.right && k.left < box.right && box.top < k.bottom && k.top < box.bottom);
    if (!same) keep.push(box);
    else {
      same.left = Math.min(same.left, box.left);
      same.top = Math.min(same.top, box.top);
      same.right = Math.max(same.right, box.right);
      same.bottom = Math.max(same.bottom, box.bottom);
    }
  }
  return { points, keep };
}
