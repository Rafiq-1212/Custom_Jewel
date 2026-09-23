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
import { Type } from '@google/genai';
import { generateJsonFromImage, type GenerateImageResult } from './gemini';
import { readImageJob, submitImageJob } from './gemini-batch';
import { cropPhotoToHead, cutBelowJawline } from './image-processing';
import { findJawline } from './jawline';
import { roughInkTrace, type Region } from './ink-filter';
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

const FACES_PROMPT = `Everything below is on a 0-1000 scale (y down, x right).
Return "boxes": one bounding box [ymin, xmin, ymax, xmax] for EVERY person's head in this photo — from the top of the hair to the chin or the bottom of the beard, and from ear to ear — and one for every visible hand. Include babies and people partly hidden. If there are none, return an empty list.`;

const FACES_SCHEMA = {
  type: Type.OBJECT,
  properties: { boxes: { type: Type.ARRAY, items: { type: Type.ARRAY, items: { type: Type.NUMBER } } } },
  required: ['boxes'],
};

/** Each box is grown by this much on every side, so a mark at the hairline or a ring on a finger sits well inside. */
const FACE_MARGIN = 0.15;

/**
 * Where the faces and hands are, so the ink filter can leave them exactly as
 * traced and clean everything else for engraving (lib/ink-filter.ts). A text
 * call on the edited photo — it looks, it never draws — costing a fraction of
 * a rupee. Anything short of a clean answer returns undefined, which the
 * filter takes as "treat the whole photo as face": the careful way round.
 */
async function findFaces(photo: Buffer): Promise<Region[] | undefined> {
  try {
    const answer = (await generateJsonFromImage({ prompt: FACES_PROMPT, image: { bytes: photo, mimeType: 'image/png' }, schema: FACES_SCHEMA })) as {
      boxes?: unknown;
    } | null;
    const boxes = Array.isArray(answer?.boxes) ? answer.boxes : [];
    const regions = boxes
      .filter((b): b is number[] => Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === 'number' && Number.isFinite(v)))
      .map(([top, left, bottom, right]) => ({ left: left / 1000, top: top / 1000, right: right / 1000, bottom: bottom / 1000 }))
      .filter((r) => r.right > r.left && r.bottom > r.top)
      .map((r) => {
        const mx = (r.right - r.left) * FACE_MARGIN;
        const my = (r.bottom - r.top) * FACE_MARGIN;
        return { left: r.left - mx, top: r.top - my, right: r.right + mx, bottom: r.bottom + my };
      });
    if (regions.length === 0) return undefined;
    console.info(`[sketch] ${regions.length} faces and hands kept exactly as traced; the rest cleaned for engraving`);
    return regions;
  } catch (error) {
    console.info(`[sketch] could not find the faces, tracing everything as face: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
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
  // A head-only style is all face, so there is nothing to ask about.
  const faces = HEAD_ONLY_CATEGORIES.has(input.category) || CROP_TO_HEAD_CATEGORIES.has(input.category) ? undefined : await findFaces(photo);
  const trace = await roughInkTrace(photo, faces);
  return { artwork: await sharp(trace).median(SMOOTHING_WINDOW).threshold(128).png().toBuffer() };
}
