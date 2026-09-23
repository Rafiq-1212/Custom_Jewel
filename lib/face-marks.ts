/**
 * Who in this photograph is wearing a bindi — asked one face at a time.
 *
 * The drawing step gets this wrong in both directions: it put a bindi on two
 * women who wear none, and it dropped the one a baby really does wear. A
 * bindi says something about a person's religion and whether she is married,
 * so both mistakes give offence, and the drawing step cannot be trusted to
 * decide for itself. So the question is asked directly, of a model that is
 * only looking, before anything is drawn.
 *
 * It used to be asked as a COUNT of the whole photograph, and that count was
 * what the drawing step was told: "ONE person in this picture is wearing a
 * bindi... draw it on that person and on nobody else." When two women both
 * wore one and the count came back as one — which it does, because a bindi is
 * a few pixels in a photo of two people — that sentence did not merely fail
 * to help, it actively removed the second woman's. Reported from real orders:
 * "sometimes I am only getting 1 pottu."
 *
 * So nothing is counted any more. Each person is found, each forehead is
 * CROPPED OUT and enlarged, and the question is asked of that crop, where the
 * mark is no longer a few pixels. The drawing step is then told about each
 * person separately, and a face nobody could be sure about is simply left out
 * of the instruction rather than asserted either way.
 *
 * All of it is text calls, so the whole check costs a fraction of a cent
 * against 15-23 rupees for the drawing it protects.
 */

import sharp from 'sharp';
import { Type } from '@google/genai';
import { generateJsonFromImage } from './gemini';

if (typeof window !== 'undefined') {
  throw new Error('lib/face-marks.ts was imported into a browser bundle. This module is server-only.');
}

const ROSTER_PROMPT = `Look at the people in this photograph, from left to right. Everything below is on a 0-1000 scale (y down, x right).

Return "people": one entry per person, ordered from the leftmost to the rightmost, each with:
- "head": the bounding box [ymin, xmin, ymax, xmax] of that person's whole head, from the top of the hair to the chin and from one ear or cheek to the other.
- "woman": true if this person is a woman or a girl.
- "mark": true if you can clearly see a mark on this person's forehead or in their hair parting right now — a bindi or pottu (a dot or shape between the eyebrows), a tilak, or sindoor in the parting. Look for a mark that is really on the skin in this photograph. Do not assume anyone wears one because of their clothes, their jewellery or where they seem to be from.`;

const ROSTER_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    people: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          head: { type: Type.ARRAY, items: { type: Type.NUMBER } },
          woman: { type: Type.BOOLEAN },
          mark: { type: Type.BOOLEAN },
        },
        required: ['head', 'woman', 'mark'],
      },
    },
  },
  required: ['people'],
};

const FOREHEAD_PROMPT = `This is a close crop of one person's head from a photograph.

Is this person wearing a mark on the forehead between the eyebrows, or sindoor in the parting of the hair — a bindi, a pottu or a tilak? It would be a small round dot or a small shape sitting ON THE SKIN of the forehead, usually red, black or maroon, or a line of red powder in the parting.

A mole, a scar, a shadow, a strand of hair, a reflection, a blur or a jewel hanging onto the forehead from a headpiece is NOT a bindi. A nose stud is not one either.

Answer "wearing": "yes" if you can plainly see such a mark, "no" if the forehead and the parting are plainly bare, and "unclear" if the crop is too small, too dark or too blurred to tell. Do not guess from the person's clothes or jewellery.`;

const FOREHEAD_SCHEMA = {
  type: Type.OBJECT,
  properties: { wearing: { type: Type.STRING, enum: ['yes', 'no', 'unclear'] } },
  required: ['wearing'],
};

/** Margin around the head box before cropping, as a fraction of the box. */
const CROP_MARGIN = 0.15;
/** The crop is enlarged to this long side before being asked about: a bindi has to be big enough to see. */
const CROP_LONG_SIDE = 768;
/** A head box smaller than this fraction of the photo on both sides is too small to crop usefully. */
const MIN_HEAD = 0.02;
/** More people than this and the per-face pass is skipped: it is a crowd, not a portrait. */
const MAX_PEOPLE = 6;

interface Person {
  /** Head box as fractions of the photo. */
  left: number;
  top: number;
  right: number;
  bottom: number;
  woman: boolean;
  mark: boolean;
}

function readPeople(answer: unknown): Person[] | null {
  const raw = (answer as { people?: unknown } | null)?.people;
  if (!Array.isArray(raw)) return null;
  const people: Person[] = [];
  for (const entry of raw) {
    const { head, woman, mark } = (entry ?? {}) as { head?: unknown; woman?: unknown; mark?: unknown };
    if (!Array.isArray(head) || head.length !== 4 || !head.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
    const [top, left, bottom, right] = head.map((n) => Math.min(1, Math.max(0, n / 1000)));
    if (right <= left || bottom <= top) continue;
    people.push({ left, top, right, bottom, woman: woman === true, mark: mark === true });
  }
  return people.sort((a, b) => a.left + a.right - (b.left + b.right));
}

async function askRoster(photo: Uint8Array, mimeType: string): Promise<Person[] | null> {
  try {
    return readPeople(await generateJsonFromImage({ prompt: ROSTER_PROMPT, image: { bytes: photo, mimeType }, schema: ROSTER_SCHEMA }));
  } catch (error) {
    console.info(`[sketch] could not look at the faces: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * The same head, cut out of the full-resolution photograph and enlarged. This
 * is the whole point of the per-face pass: in a photo of two people a bindi
 * is a handful of pixels, and at that size it is a coin toss. Cut out and
 * blown up it is a red dot on a forehead.
 */
async function askForehead(photo: Uint8Array, person: Person): Promise<'yes' | 'no' | 'unclear'> {
  try {
    const image = sharp(Buffer.from(photo));
    const { width, height } = await image.metadata();
    if (!width || !height) return 'unclear';
    const marginX = (person.right - person.left) * CROP_MARGIN;
    const marginY = (person.bottom - person.top) * CROP_MARGIN;
    const left = Math.round(Math.max(0, person.left - marginX) * width);
    const top = Math.round(Math.max(0, person.top - marginY) * height);
    const cropWidth = Math.round(Math.min(1, person.right + marginX) * width) - left;
    const cropHeight = Math.round(Math.min(1, person.bottom + marginY) * height) - top;
    if (cropWidth < 16 || cropHeight < 16) return 'unclear';
    const crop = await image
      .extract({ left, top, width: cropWidth, height: cropHeight })
      .resize({ width: CROP_LONG_SIDE, height: CROP_LONG_SIDE, fit: 'inside', withoutEnlargement: false, kernel: 'lanczos3' })
      .png()
      .toBuffer();
    const answer = await generateJsonFromImage({
      prompt: FOREHEAD_PROMPT,
      image: { bytes: crop, mimeType: 'image/png' },
      schema: FOREHEAD_SCHEMA,
    });
    const wearing = (answer as { wearing?: unknown } | null)?.wearing;
    return wearing === 'yes' || wearing === 'no' ? wearing : 'unclear';
  } catch (error) {
    console.info(`[sketch] could not look at one forehead: ${error instanceof Error ? error.message : String(error)}`);
    return 'unclear';
  }
}

/** One person the drawing step will be told about by their place in the row. */
export interface MarkedFace {
  /** "on the left", "second from the left", "in the photograph". */
  where: string;
  wears: boolean;
}

export interface FaceMarks {
  /**
   * One entry per person whose forehead could be settled, or null when the
   * two looks at the photograph disagreed about who is even in it. An empty
   * list means the same as null: say nothing.
   */
  faces: MarkedFace[] | null;
  /**
   * True when every person in the photograph was settled. Only then can the
   * drawing step be told the flat fact that NOBODY wears one; with a face
   * still unaccounted for, the denial has to be limited to the faces that
   * were actually checked.
   */
  complete: boolean;
  /** True when either look saw a woman or a girl — the drawing step is then told to spend more on those faces. */
  anyWomen: boolean;
}

function placeInRow(index: number, total: number): string {
  if (total === 1) return 'the person in the photograph';
  const ordinals = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];
  if (index === 0) return 'the person furthest to the LEFT';
  if (index === total - 1) return 'the person furthest to the RIGHT';
  return `the ${ordinals[index] ?? `${index + 1}th`} person from the left`;
}

/**
 * Two independent looks at the whole photograph settle who is in it; a third
 * call per face settles each forehead. The two looks have to agree on the
 * number of people before anything is said at all — if they cannot agree on
 * that, their boxes cannot be trusted to crop by either.
 *
 * The per-face answer wins where it is sure, because it has by far the best
 * view. Where it is not, the two whole-photo looks decide, and only if they
 * agreed with each other; otherwise that person is dropped from the list and
 * the drawing step is told nothing about them, which leaves it exactly where
 * it would have been anyway.
 */
export async function lookAtFaces(photo: Uint8Array, mimeType: string): Promise<FaceMarks> {
  const [first, second] = await Promise.all([askRoster(photo, mimeType), askRoster(photo, mimeType)]);
  const anyWomen = [first, second].some((people) => (people ?? []).some((person) => person.woman));

  if (!first || !second || first.length === 0 || first.length !== second.length) {
    console.info(
      `[sketch] faces: the two looks saw ${first?.length ?? '?'} and ${second?.length ?? '?'} people, so nothing is said about bindis${anyWomen ? '; women seen — asking for extra detail on them' : ''}`,
    );
    return { faces: null, complete: false, anyWomen };
  }

  const people = first;
  const tooManyOrTooSmall = people.length > MAX_PEOPLE;
  const closeUp = tooManyOrTooSmall
    ? people.map(() => 'unclear' as const)
    : await Promise.all(
        people.map((person) =>
          person.right - person.left < MIN_HEAD && person.bottom - person.top < MIN_HEAD
            ? Promise.resolve('unclear' as const)
            : askForehead(photo, person),
        ),
      );

  const faces: MarkedFace[] = [];
  const log: string[] = [];
  people.forEach((person, index) => {
    const close = closeUp[index];
    const agreed = person.mark === second[index].mark;
    const wears = close === 'unclear' ? (agreed ? person.mark : null) : close === 'yes';
    log.push(`${index + 1}:${close}${close === 'unclear' ? `/${agreed ? (person.mark ? 'both yes' : 'both no') : 'no agreement'}` : ''}`);
    if (wears !== null) faces.push({ where: placeInRow(index, people.length), wears });
  });
  console.info(
    `[sketch] faces: ${people.length} people, bindis ${log.join(' ')}${faces.length < people.length ? ' (the rest left unsaid)' : ''}${anyWomen ? '; women seen — asking for extra detail on them' : ''}`,
  );

  return { faces: faces.length > 0 ? faces : null, complete: faces.length === people.length, anyWomen };
}
