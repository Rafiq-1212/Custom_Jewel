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
Return "people": how many people are in the photograph, and "wearing": how many of them have such a mark clearly visible.`;

const SCHEMA = {
  type: Type.OBJECT,
  properties: { people: { type: Type.NUMBER }, wearing: { type: Type.NUMBER } },
  required: ['people', 'wearing'],
};

async function countWearers(photo: Uint8Array, mimeType: string): Promise<number | null> {
  try {
    const answer = await generateJsonFromImage({ prompt: PROMPT, image: { bytes: photo, mimeType }, schema: SCHEMA });
    const { people, wearing } = (answer ?? {}) as { people?: unknown; wearing?: unknown };
    if (typeof people !== 'number' || typeof wearing !== 'number') return null;
    if (!Number.isFinite(people) || !Number.isFinite(wearing) || people < 1 || wearing < 0) return null;
    return wearing;
  } catch (error) {
    console.info(`[sketch] could not check for forehead marks: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * How many people wear one, when two separate looks agree; null when they
 * disagree or the check could not be made, in which case the drawing step is
 * told nothing and falls back on its own judgement.
 */
export async function countForeheadMarks(photo: Uint8Array, mimeType: string): Promise<number | null> {
  const [first, second] = await Promise.all([countWearers(photo, mimeType), countWearers(photo, mimeType)]);
  const agreed = first !== null && first === second ? first : null;
  console.info(
    `[sketch] forehead marks counted: ${first ?? '?'} and ${second ?? '?'}${agreed === null ? ' — no agreement, saying nothing' : ` — telling the drawing step there ${agreed === 1 ? 'is 1' : `are ${agreed}`}`}`,
  );
  return agreed;
}
