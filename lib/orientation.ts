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
