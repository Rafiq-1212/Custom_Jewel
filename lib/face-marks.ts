/**
 * Does anyone in this photograph wear a bindi?
 *
 * The drawing step kept putting one on women who wear none. Telling it not to
 * invent marks did not stop it — the pull of "Indian woman in a saree, there
 * should be a dot" is stronger than a conditional rule, and the client is
 * right that it matters: a bindi says something about a person's religion and
 * whether she is married, so giving one to someone who does not wear it gives
 * offence.
 *
 * So the question is asked directly, of a model that is only looking, before
 * anything is drawn. When the answer is "nobody", the drawing step is handed
 * a flat statement of fact instead of a rule to apply, which it follows.
 *
 * The count is used in both directions, because the drawing step gets it
 * wrong in both: it put a bindi on two women who wear none, and it dropped
 * the one a baby really does wear. Two independent answers have to agree
 * before anything is said at all — measured on four photographs the count
 * was right and steady on three and wobbled on the fourth, and on a
 * disagreement the drawing step is simply told nothing.
 *
 * A text call, so it costs a fraction of a cent: a hundredth of the price of
 * the drawing it protects.
 */

import { Type } from '@google/genai';
import { generateJsonFromImage } from './gemini';

if (typeof window !== 'undefined') {
  throw new Error('lib/face-marks.ts was imported into a browser bundle. This module is server-only.');
}

const PROMPT = `Look at each person's forehead in this photograph, one by one, and at the parting of their hair.
Count how many of them are ACTUALLY wearing a visible mark there right now: a bindi or pottu (a dot or shape between the eyebrows), a tilak, or sindoor in the parting. Look for a mark that is really on the skin in this photograph. Do not assume anyone wears one because of their clothes, their jewellery or where they seem to be from.
Return "people": how many people are in the photograph, "wearing": how many of them have such a mark clearly visible, and "women": how many of the people are women or girls.`;

const SCHEMA = {
  type: Type.OBJECT,
  properties: { people: { type: Type.NUMBER }, wearing: { type: Type.NUMBER }, women: { type: Type.NUMBER } },
  required: ['people', 'wearing', 'women'],
};

interface Counts {
  wearing: number;
  women: number;
}

async function countPeople(photo: Uint8Array, mimeType: string): Promise<Counts | null> {
  try {
    const answer = await generateJsonFromImage({ prompt: PROMPT, image: { bytes: photo, mimeType }, schema: SCHEMA });
    const { people, wearing, women } = (answer ?? {}) as { people?: unknown; wearing?: unknown; women?: unknown };
    if (typeof people !== 'number' || typeof wearing !== 'number') return null;
    if (!Number.isFinite(people) || !Number.isFinite(wearing) || people < 1 || wearing < 0) return null;
    const womenCount = typeof women === 'number' && Number.isFinite(women) && women >= 0 ? women : 0;
    return { wearing, women: womenCount };
  } catch (error) {
    console.info(`[sketch] could not look at the faces: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export interface FaceCounts {
  /** People wearing a bindi, when two looks agree; null when they do not. */
  foreheadMarks: number | null;
  /** True when either look saw a woman or a girl — the drawing step is then told to spend more on those faces. */
  anyWomen: boolean;
}

/**
 * Both answers come from the same two calls, so asking about women costs
 * nothing on top of the bindi check. The bindi count still needs the two to
 * agree, since acting on it either way can spoil a portrait; the women flag
 * does not, because all it buys is extra care on a face.
 */
export async function lookAtFaces(photo: Uint8Array, mimeType: string): Promise<FaceCounts> {
  const [first, second] = await Promise.all([countPeople(photo, mimeType), countPeople(photo, mimeType)]);
  const foreheadMarks = first !== null && second !== null && first.wearing === second.wearing ? first.wearing : null;
  const anyWomen = (first?.women ?? 0) > 0 || (second?.women ?? 0) > 0;
  console.info(
    `[sketch] faces: bindis ${first?.wearing ?? '?'} and ${second?.wearing ?? '?'}${foreheadMarks === null ? ' (no agreement, saying nothing)' : ''}; women ${first?.women ?? '?'} and ${second?.women ?? '?'}${anyWomen ? ' — asking for extra detail on them' : ''}`,
  );
  return { foreheadMarks, anyWomen };
}
