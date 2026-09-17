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
Also return "earrings": one bounding box [ymin, xmin, ymax, xmax] on the same 0-1000 scale for each earring that hangs below the ear lobe, or an empty list if there are none.`;

const JAW_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    head: { type: Type.ARRAY, items: { type: Type.NUMBER } },
    jaw: { type: Type.ARRAY, items: { type: Type.ARRAY, items: { type: Type.NUMBER } } },
    ear_lobes: { type: Type.ARRAY, items: { type: Type.ARRAY, items: { type: Type.NUMBER } } },
    earrings: { type: Type.ARRAY, items: { type: Type.ARRAY, items: { type: Type.NUMBER } } },
  },
  required: ['head', 'jaw', 'ear_lobes', 'earrings'],
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

  const boxes = (answer as { earrings?: unknown }).earrings;
  const keep: KeepBox[] = Array.isArray(boxes)
    ? boxes
        .filter((b): b is number[] => Array.isArray(b) && b.length === 4 && b.every((n) => typeof n === 'number' && Number.isFinite(n)))
        .map(([top, left, bottom, right]) => ({ left: left / 1000, top: top / 1000, right: right / 1000, bottom: bottom / 1000 }))
        .filter((b) => b.right > b.left && b.bottom > b.top && b.right - b.left < MAX_EARRING && b.bottom - b.top < MAX_EARRING)
    : [];
  return { points, keep };
}
