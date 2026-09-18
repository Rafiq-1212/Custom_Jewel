/**
 * Photo to engraving sketch, in the same steps the client uses by hand:
 *
 *   1. Enhance (AI photo edit): remove the background, paint out anything
 *      that is not the subject, correct colour and exposure and sharpen
 *      facial detail. No drawing, and no re-posing. Face Pendant is then
 *      cut to the head on pixels, along a jawline located by a text call
 *      (lib/jawline.ts), never by asking the image model to do it.
 *   2. Rough trace (lib/ink-filter.ts, no AI): a comic ink filter on the
 *      enhanced photo, so every line sits on the photo's real edges.
 *   3. Finish (AI): detailed line art from the rough trace, keeping its line
 *      positions, using the enhanced photo to read what each line is.
 *
 * The result goes on to lib/image-processing.ts for trimming and the
 * transparent background, exactly as before.
 *
 * Two AI calls per sketch (steps 1 and 3), occasionally three (see
 * `leftObjectsBehind`). After each AI step the result is checked for an
 * accidental left-right mirror and flipped back if needed (lib/orientation.ts).
 */

import sharp from 'sharp';
import {
  GeminiGenerationError,
  generateImageFromImage as generateOnce,
  type GenerateImageFromImageInput,
  type GenerateImageResult,
} from './gemini';
import { cropPhotoToHead, cutBelowJawline } from './image-processing';
import { findJawline } from './jawline';
import { roughInkTrace } from './ink-filter';
import { unmirror } from './orientation';
import type { CategoryId } from './pendant-categories';
import { buildEnhancePrompt, buildFinishPrompt, ENHANCE_RETRY_NOTE } from './sketch-prompts';
import { noOneWearsAForeheadMark } from './face-marks';

if (typeof window !== 'undefined') {
  throw new Error('lib/sketch-pipeline.ts was imported into a browser bundle. This module is server-only.');
}

/**
 * The finish step draws at 4K. The bigger the canvas, the more the model
 * actually draws: at 1K a face in a couple photo was only about 250 px wide,
 * too small for individual hair strands; at 2K the strands appear but hair
 * still comes back as chunky masses; at 4K it draws each strand, the
 * flyaways around the edge of the hair, eyelashes and iris detail.
 *
 * The photo edit stays at 1K. Customer photos are rarely larger than that,
 * so a bigger canvas adds no real detail there, and in testing the 2K edit
 * repeatedly failed to remove objects (a car door) that the 1K edit removed
 * every time.
 */
const FINISH_IMAGE_SIZE = '4K';
/**
 * The 4K drawing is scaled back down to this longest side before anything
 * else sees it — the same size the 2K finish used to produce, so the master
 * sketch, the stored data URL and the vector exports stay exactly as heavy
 * as before. The extra resolution is spent on how much the model draws, not
 * on the size of the file: scaling down packs those extra strokes into
 * finer, cleaner lines (plain supersampling) instead of throwing them away.
 */
const MASTER_MAX_DIM = 2700;

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

/**
 * The model now and then refuses a perfectly ordinary family photo with the
 * catch-all reason "OTHER", and the identical request goes through on the
 * next try (seen while testing: one of two identical requests refused). One
 * retry for that specific refusal; any other safety reason is respected.
 */
async function generateImageFromImage(input: GenerateImageFromImageInput): Promise<GenerateImageResult> {
  try {
    return await generateOnce(input);
  } catch (error) {
    if (error instanceof GeminiGenerationError && error.code === 'SAFETY_BLOCKED' && /\bOTHER\b/.test(error.detail ?? '')) {
      console.info(`[sketch] refused with reason OTHER, retrying once`);
      return generateOnce(input);
    }
    throw error;
  }
}

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

async function enhance(input: SketchInput, retry: boolean): Promise<GenerateImageResult> {
  const edited = await generateImageFromImage({
    prompt: retry ? `${buildEnhancePrompt(input.category)}\n\n${ENHANCE_RETRY_NOTE}` : buildEnhancePrompt(input.category),
    images: [{ bytes: input.imageBytes, mimeType: input.mimeType }],
  });
  const checked = await unmirror(Buffer.from(input.imageBytes), Buffer.from(edited.bytes));
  if (!checked.flipped) return edited;
  console.info(`[sketch] ${input.category}: photo edit came back mirrored, flipped it back`);
  return { bytes: checked.image, mimeType: 'image/png' };
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

export async function createSketch(input: SketchInput): Promise<Buffer> {
  let enhanced = await enhance(input, false);
  if (HEAD_ONLY_CATEGORIES.has(input.category) && (await leftObjectsBehind(enhanced))) {
    console.info(`[sketch] ${input.category}: objects left along the bottom after the photo edit, retrying once`);
    enhanced = await enhance(input, true);
  }

  const edited = Buffer.from(enhanced.bytes);
  // Asked of the ORIGINAL photograph, not the edited one: the edit can lose a
  // small mark, and a mark the check misses is one the drawing will be told
  // nothing about, which is the safe way round.
  const [photo, noForeheadMarks] = await Promise.all([
    CROP_TO_HEAD_CATEGORIES.has(input.category) ? cutToHead(edited, enhanced.mimeType) : Promise.resolve(edited),
    noOneWearsAForeheadMark(input.imageBytes, input.mimeType),
  ]);

  const rough = await roughInkTrace(photo);

  const finished = await generateImageFromImage({
    prompt: buildFinishPrompt({ noForeheadMarks }),
    images: [
      { bytes: photo, mimeType: 'image/png' },
      { bytes: rough, mimeType: 'image/png' },
    ],
    imageSize: FINISH_IMAGE_SIZE,
  });

  const scaled = await sharp(Buffer.from(finished.bytes))
    .resize({ width: MASTER_MAX_DIM, height: MASTER_MAX_DIM, fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' })
    .png()
    .toBuffer();

  const checked = await unmirror(rough, scaled);
  if (checked.flipped) console.info(`[sketch] ${input.category}: finished sketch came back mirrored, flipped it back`);
  return checked.image;
}
