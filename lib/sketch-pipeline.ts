/**
 * Photo to engraving artwork, with no AI drawing anywhere in it:
 *
 *   1. Photo edit (AI, batched at half price): remove the background, paint
 *      out anything that is not the subject, correct colour and exposure.
 *      No drawing, and no re-posing. Face Pendant is then cut to the head on
 *      pixels, along a jawline located by a text call (lib/jawline.ts).
 *   2. Ink filter (lib/ink-filter.ts, no AI): a comic ink filter on that
 *      edited photo. This IS the artwork.
 *
 * There used to be a third step, an AI "finish" that redrew the ink trace as
 * clean line art. It was dropped because it drew people who were not in the
 * photograph: shown a couple at a temple, it came back with a different
 * face, a different saree, a shirt with a pocket nobody wore, and a bindi on
 * a woman who wears none. Every prompt rule added against that only moved
 * the problem. The ink filter cannot invent anything — every line in it is
 * an edge in the real photo — so the likeness is the photo's own.
 *
 * The photo edit is a batch job, so the browser drives this by polling
 * (app/api/sketch/route.ts): `startTouchUp` submits it, and `finishSketch`
 * reads it back and makes the artwork. Nothing is stored in between.
 */

import sharp from 'sharp';
import { type GenerateImageResult } from './gemini';
import { readImageJob, submitImageJob } from './gemini-batch';
import { cropPhotoToHead, cutBelowJawline } from './image-processing';
import { findJawline } from './jawline';
import { roughInkTrace } from './ink-filter';
import { unmirror } from './orientation';
import type { CategoryId } from './pendant-categories';
import { buildEnhancePrompt, ENHANCE_RETRY_NOTE } from './sketch-prompts';

if (typeof window !== 'undefined') {
  throw new Error('lib/sketch-pipeline.ts was imported into a browser bundle. This module is server-only.');
}

/**
 * Styles whose framing ends above the bottom edge of the photo, so the
 * bottom of the edited photo must be white. Face Pendant is not one of them
 * any more: its photo edit now keeps the whole person and the head is cut
 * out afterwards, on pixels (`cropPhotoToHead`), because asking the model
 * for that crop made it re-render the head.
 */
const HEAD_ONLY_CATEGORIES: ReadonlySet<CategoryId> = new Set<CategoryId>(['pet']);
/** Styles whose sketch is cut down to the head after the photo edit. */
const CROP_TO_HEAD_CATEGORIES: ReadonlySet<CategoryId> = new Set<CategoryId>(['face']);
/** Height of the bottom band that is checked, as a fraction of the image height. */
const BOTTOM_BAND = 0.04;
/** More than this share of non-white pixels in the bottom band means something was left behind. */
const MAX_BOTTOM_INK = 0.12;

export interface SketchInput {
  imageBytes: Uint8Array;
  mimeType: string;
  category: CategoryId;
}

/**
 * True when a head-only edit still has something reaching the bottom of the
 * photo. Verified case: a man leaning out of a car window came back with the
 * car door kept, and the finish step then drew the door in full detail. The
 * head always ends at the chin, so real content never touches the bottom.
 */
async function leftObjectsBehind(image: GenerateImageResult): Promise<boolean> {
  const { data, info } = await sharp(Buffer.from(image.bytes))
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const bandStart = Math.floor(info.height * (1 - BOTTOM_BAND));
  let ink = 0;
  let total = 0;
  for (let y = bandStart; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      const luminance = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (luminance < 235) ink++;
      total++;
    }
  }
  return total > 0 && ink / total > MAX_BOTTOM_INK;
}

/** Submits the photo edit. `retry` adds the note for a pet photo that kept a car door. */
export async function startTouchUp(input: SketchInput, retry = false): Promise<string> {
  return submitImageJob(
    {
      prompt: retry ? `${buildEnhancePrompt(input.category)}\n\n${ENHANCE_RETRY_NOTE}` : buildEnhancePrompt(input.category),
      images: [{ bytes: input.imageBytes, mimeType: input.mimeType }],
    },
    `touch-up ${input.category}`,
  );
}

/**
 * Face Pendant: the head alone. The jawline is asked of a text model
 * (lib/jawline.ts), which works whatever the photo looks like; only if that
 * fails are the pixel heuristics used, which need shoulders in the frame
 * and a full beard to find anything.
 */
async function cutToHead(edited: Buffer, mimeType: string): Promise<Buffer> {
  const jaw = await findJawline(edited, mimeType);
  if (jaw) {
    console.info(`[sketch] face: jawline found (${jaw.points.length} points, ${jaw.keep.length} earrings kept), cutting below it`);
    return cutBelowJawline(edited, jaw.points, jaw.keep);
  }
  console.info('[sketch] face: no usable jawline, using the pixel cut');
  return cropPhotoToHead(edited);
}

/**
 * The touched-up photo as the drawing step needs it: unmirrored against the
 * original, and cut to the head for a Face Pendant. The edit itself is read
 * from its job rather than stored anywhere, which costs one API read and no
 * infrastructure.
 */
async function touchedUpPhoto(edited: GenerateImageResult, original: Uint8Array, category: CategoryId): Promise<Buffer> {
  const checked = await unmirror(Buffer.from(original), Buffer.from(edited.bytes));
  if (checked.flipped) console.info(`[sketch] ${category}: photo edit came back mirrored, flipped it back`);
  const photo = checked.image;
  return CROP_TO_HEAD_CATEGORIES.has(category) ? cutToHead(photo, 'image/png') : photo;
}

/**
 * Smooths the filter's pixel stair-steps into ink-like edges. A median over a
 * small window rounds the jaggies of a thresholded image without moving any
 * line: a stroke is kept wherever most of its neighbourhood is ink.
 *
 * 3, not 5: a 5x5 median snaps any stroke thinner than about three pixels
 * into dashes, which is where a good part of the "broken lines" came from.
 * Measured on a real couple photo, 3 leaves 17% fewer separate fragments
 * (408 -> 340) with the same amount of ink and every forehead mark intact.
 */
const SMOOTHING_WINDOW = 3;

export type FinishStep = { touchUpJob: string } | { artwork: Buffer };

/**
 * Reads the finished photo edit and turns it into the artwork. When a
 * head-only edit came back with something still touching the bottom, this
 * submits a second photo edit instead and says so, and the browser simply
 * waits again.
 */
export async function finishSketch(input: SketchInput & { touchUpJob: string; retried?: boolean }): Promise<FinishStep> {
  const edited = await readImageJob(input.touchUpJob, `touch-up ${input.category}`, { count: true });
  if (!input.retried && HEAD_ONLY_CATEGORIES.has(input.category) && (await leftObjectsBehind(edited))) {
    console.info(`[sketch] ${input.category}: objects left along the bottom after the photo edit, retrying once`);
    return { touchUpJob: await startTouchUp(input, true) };
  }
  const photo = await touchedUpPhoto(edited, input.imageBytes, input.category);
  const trace = await roughInkTrace(photo);
  return { artwork: await sharp(trace).median(SMOOTHING_WINDOW).threshold(128).png().toBuffer() };
}
