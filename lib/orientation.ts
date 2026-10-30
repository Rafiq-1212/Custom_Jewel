/**
 * Catches an AI image step that mirrored its input.
 *
 * The image models occasionally return a left-right flipped picture (seen
 * twice while testing the sketch pipeline: the person came back facing the
 * other way), which ruins a likeness. A prompt rule did not stop it, so this
 * checks the pixels instead. It compares a small grayscale version of the
 * output with the reference image, both as-is and mirrored, and flips the
 * output back when the mirrored version matches clearly better.
 *
 * Only valid when both images show the same framing, which is true for every
 * step of the sketch pipeline (the edit and the finish never re-crop).
 */

import sharp from 'sharp';
import { Type } from '@google/genai';
import { generateJsonFromImage } from './gemini';

if (typeof window !== 'undefined') {
  throw new Error('lib/orientation.ts was imported into a browser bundle. This module is server-only.');
}

const SAMPLE = 96;
/** The mirrored match must beat the direct match by this much before anything is flipped. */
const MARGIN = 0.08;

async function sample(image: Buffer, mirror: boolean): Promise<Float32Array> {
  let pipeline = sharp(image).flatten({ background: '#ffffff' });
  if (mirror) pipeline = pipeline.flop();
  const data = await pipeline.greyscale().resize(SAMPLE, SAMPLE, { fit: 'fill' }).blur(1.5).raw().toBuffer();
  const out = new Float32Array(SAMPLE * SAMPLE);
  let mean = 0;
  for (let i = 0; i < out.length; i++) mean += data[i];
  mean /= out.length;
  let norm = 0;
  for (let i = 0; i < out.length; i++) {
    out[i] = data[i] - mean;
    norm += out[i] * out[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

function correlation(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

export interface OrientationResult {
  image: Buffer;
  flipped: boolean;
  direct: number;
  mirrored: number;
}

/** Returns `candidate`, flipped back if it looks like a mirror image of `reference`. */
export async function unmirror(reference: Buffer, candidate: Buffer): Promise<OrientationResult> {
  const [ref, direct, mirrored] = await Promise.all([
    sample(reference, false),
    sample(candidate, false),
    sample(candidate, true),
  ]);
  const directScore = correlation(ref, direct);
  const mirroredScore = correlation(ref, mirrored);
  const flipped = mirroredScore > directScore + MARGIN;
  const image = flipped ? await sharp(candidate).flop().png().toBuffer() : candidate;
  return { image, flipped, direct: directScore, mirrored: mirroredScore };
}

const UP_PROMPT = `Which edge of this picture do the tops of the people's heads point towards (or the animals', if there are no people)? Answer for how the PHOTO ITSELF is turned, the way most of the heads point: a person tilting their head does not count. Return "heads": exactly one of "top", "left", "right" or "bottom".`;
const UP_SCHEMA = { type: Type.OBJECT, properties: { heads: { type: Type.STRING, enum: ['top', 'left', 'right', 'bottom'] } }, required: ['heads'] };
/** Clockwise turn that brings heads pointing at each edge to the top. */
const TURN: Record<string, number> = { top: 0, right: 270, bottom: 180, left: 90 };

/**
 * The photo the right way up. A phone photo's rotation flag is applied, and
 * one saved sideways with no flag at all (a couple, 28 Oct: an edited copy
 * saved as a PNG on its side) is turned by asking a text model which way the
 * heads point — a fraction of a rupee. Drawn sideways, it came back sideways
 * and mirrored, since the mirror check compares framings. Any failure keeps
 * the photo as it was.
 */
export async function upright(bytes: Uint8Array, mimeType: string): Promise<{ imageBytes: Uint8Array; mimeType: string }> {
  const meta = await sharp(bytes).metadata();
  const encode = (image: ReturnType<typeof sharp>) => (meta.format === 'jpeg' ? image.jpeg({ quality: 95 }) : image);
  let photo = (meta.orientation ?? 1) > 1 ? await encode(sharp(bytes).rotate()).toBuffer() : Buffer.from(bytes);
  try {
    const small = await sharp(photo).resize({ width: 768, height: 768, fit: 'inside' }).jpeg().toBuffer();
    const answer = (await generateJsonFromImage({ prompt: UP_PROMPT, image: { bytes: small, mimeType: 'image/jpeg' }, schema: UP_SCHEMA })) as { heads?: unknown } | null;
    const turn = TURN[String(answer?.heads)] ?? 0;
    if (turn) {
      console.info(`[sketch] photo was on its side (heads to the ${String(answer?.heads)}), turned ${turn} degrees`);
      photo = await encode(sharp(photo).rotate(turn)).toBuffer();
    }
  } catch (error) {
    console.info(`[sketch] could not tell which way up the photo is, keeping it: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { imageBytes: new Uint8Array(photo), mimeType };
}
