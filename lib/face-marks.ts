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
 * Used ONLY to forbid, never to require. A wrong "nobody" costs a missing
 * dot; a wrong "somebody" would put one on a face that should not have it,
 * and that is the failure worth avoiding. Two independent answers have to
 * agree before the prohibition is used — measured on four photographs, the
 * count was right and steady on three and wobbled on one, which is exactly
 * the case the agreement rule covers.
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

/** True only when two separate looks both say nobody in the photo wears one. */
export async function noOneWearsAForeheadMark(photo: Uint8Array, mimeType: string): Promise<boolean> {
  const [first, second] = await Promise.all([countWearers(photo, mimeType), countWearers(photo, mimeType)]);
  const nobody = first === 0 && second === 0;
  console.info(`[sketch] forehead marks counted: ${first ?? '?'} and ${second ?? '?'}${nobody ? ' — telling the drawing step there are none' : ''}`);
  return nobody;
}
