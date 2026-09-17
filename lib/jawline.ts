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

const JAW_PROMPT = `This photo shows one person's head. Trace the lower outline of the HEAD, the line where the head ends and the neck begins: start just under one ear lobe, follow the edge of the jaw (or the bottom edge of the beard, if the beard hangs lower than the jaw) down around the chin, and up to just under the other ear lobe. If an ear is hidden, start where the jaw meets the hairline on that side.
Return 9 to 15 points in order from the left side of the image to the right, as [y, x] pairs normalised to 0-1000 (y down, x right).
Also return "ear_lobes": the lowest point [y, x] of each ear lobe that is visible (zero, one or two points).
Also return "earrings": one bounding box [ymin, xmin, ymax, xmax] on the same 0-1000 scale for each earring that hangs below the ear lobe, or an empty list if there are none.`;

const JAW_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    jaw: { type: Type.ARRAY, items: { type: Type.ARRAY, items: { type: Type.NUMBER } } },
    ear_lobes: { type: Type.ARRAY, items: { type: Type.ARRAY, items: { type: Type.NUMBER } } },
    earrings: { type: Type.ARRAY, items: { type: Type.ARRAY, items: { type: Type.NUMBER } } },
  },
  required: ['jaw', 'ear_lobes', 'earrings'],
};

const MIN_POINTS = 5;
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
