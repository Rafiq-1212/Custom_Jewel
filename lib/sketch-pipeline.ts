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
 *
 * BOTH image calls go through the Batch API at half price (lib/gemini-batch.ts),
 * which is what brings a finished piece from about 28 rupees to about 14. A
 * batch job cannot be waited for inside one request — measured, the photo
 * edit took 87 seconds and the 4K drawing 379 — so this module no longer runs
 * the pipeline end to end. It exposes the three points where work actually
 * happens, and the browser drives them by polling (app/api/sketch/route.ts):
 *
 *   startTouchUp   submit step 1
 *   startFinish    read step 1's result, do step 2, submit step 3
 *   collectSketch  read step 3's result and finish the artwork
 *
 * Nothing is stored between those calls. A finished batch job's result stays
 * readable from Google, so the touched-up photo is simply read again when it
 * is needed — which also makes a redraw cheap and certain: the same photo-edit
 * job is reused and only the drawing is paid for again.
 */

import sharp from 'sharp';
import { type GenerateImageResult } from './gemini';
import { readImageJob, submitImageJob } from './gemini-batch';
import { cropPhotoToHead, cutBelowJawline } from './image-processing';
import { findJawline } from './jawline';
import { roughInkTrace } from './ink-filter';
import { unmirror } from './orientation';
import type { CategoryId } from './pendant-categories';
import { buildEnhancePrompt, buildFinishPrompt, ENHANCE_RETRY_NOTE } from './sketch-prompts';
import { lookAtFaces } from './face-marks';
import { TYPICAL_COST } from './cost';

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
 * Draft mode draws the finish at 2K instead. Image output is billed per
 * image, not per pixel, and the 2K image is the cheaper of the two: measured
 * end to end, a draft sketch costs $0.176 against $0.226 for the final one,
 * so previewing a photo costs about a fifth less than finishing it.
 *
 * What it costs in quality is real and was measured side by side: teeth stop
 * being drawn as separate teeth, eyelashes come back as a solid lash line
 * and hair goes back to chunky masses instead of strands. It is a preview —
 * good enough to judge framing, pose, whether the right people are in it and
 * whether anything was invented — and not the file that goes to the laser.
 */
const DRAFT_IMAGE_SIZE = '2K';
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

/** 'draft' finishes at 2K for a cheap preview; 'final' at 4K. */
export type SketchQuality = 'draft' | 'final';

export interface SketchInput {
  imageBytes: Uint8Array;
  mimeType: string;
  category: CategoryId;
  quality?: SketchQuality;
  /**
   * Redo the photo edit instead of reusing the one from an earlier attempt on
   * this same photograph (lib/photo-cache.ts). A plain redraw leaves the
   * photo alone and re-rolls only the drawing, which is what "draw it again"
   * usually means and costs a third less; this is for the other case, where
   * the photo edit itself went wrong — an arm painted out, an object left in.
   */
  redoPhotoEdit?: boolean;
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

export interface FinishStep {
  /** A fresh photo-edit job, when the first edit left objects behind and has to be redone. */
  touchUpJob?: string;
  /** The drawing job, once the photo is good enough to draw from. */
  finishJob?: string;
}

/**
 * Reads the finished photo edit, does the free middle step on it, and submits
 * the drawing. When a head-only edit came back with something still touching
 * the bottom, this submits a second photo edit instead and says so, and the
 * browser simply waits again.
 */
export async function startFinish(input: SketchInput & { touchUpJob: string; retried?: boolean }): Promise<FinishStep> {
  // This is the step that pays for the photo edit: it is the one that reads
  // it in order to move the sketch forward. Later reads of the same job cost
  // nothing more and are not counted again.
  const edited = await readImageJob(input.touchUpJob, `touch-up ${input.category}`, { count: true });
  if (!input.retried && HEAD_ONLY_CATEGORIES.has(input.category) && (await leftObjectsBehind(edited))) {
    console.info(`[sketch] ${input.category}: objects left along the bottom after the photo edit, retrying once`);
    return { touchUpJob: await startTouchUp(input, true) };
  }

  // The faces are asked of the ORIGINAL photograph, not the edited one: the
  // edit can lose a small mark, and a mark the check misses is one the
  // drawing will be told nothing about, which is the safe way round.
  const [photo, faces] = await Promise.all([
    touchedUpPhoto(edited, input.imageBytes, input.category),
    lookAtFaces(input.imageBytes, input.mimeType),
  ]);
  const rough = await roughInkTrace(photo);

  const finishJob = await submitImageJob(
    {
      prompt: buildFinishPrompt(faces),
      images: [
        { bytes: photo, mimeType: 'image/png' },
        { bytes: rough, mimeType: 'image/png' },
      ],
      imageSize: input.quality === 'draft' ? DRAFT_IMAGE_SIZE : FINISH_IMAGE_SIZE,
    },
    `finish ${input.category} ${input.quality === 'draft' ? DRAFT_IMAGE_SIZE : FINISH_IMAGE_SIZE}`,
  );
  return { finishJob };
}

/**
 * The finished drawing, scaled down and checked for a mirror. The rough trace
 * is rebuilt here from the same photo edit rather than carried around: it is
 * deterministic and takes a moment, where passing it between requests would
 * mean storing a megabyte somewhere for the sake of it.
 */
export async function collectSketch(input: {
  touchUpJob: string;
  finishJob: string;
  imageBytes: Uint8Array;
  category: CategoryId;
  quality?: SketchQuality;
}): Promise<Buffer> {
  const size = input.quality === 'draft' ? DRAFT_IMAGE_SIZE : FINISH_IMAGE_SIZE;
  const [finished, edited] = await Promise.all([
    readImageJob(input.finishJob, `finish ${input.category} ${size}`, { count: true }),
    readImageJob(input.touchUpJob, `touch-up ${input.category}`),
  ]);
  const photo = await touchedUpPhoto(edited, input.imageBytes, input.category);
  const rough = await roughInkTrace(photo);

  const scaled = await sharp(Buffer.from(finished.bytes))
    .resize({ width: MASTER_MAX_DIM, height: MASTER_MAX_DIM, fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' })
    .png()
    .toBuffer();

  const checked = await unmirror(rough, scaled);
  if (checked.flipped) console.info(`[sketch] ${input.category}: finished sketch came back mirrored, flipped it back`);
  return checked.image;
}

/** What a redraw saves by reusing the photo-edit job instead of paying for a new one. */
export function redrawSaving(category: CategoryId): number {
  return (
    TYPICAL_COST.batchedTouchUp + TYPICAL_COST.faceCheck + (CROP_TO_HEAD_CATEGORIES.has(category) ? TYPICAL_COST.jawline : 0)
  );
}
