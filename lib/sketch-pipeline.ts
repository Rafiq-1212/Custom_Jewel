/**
 * Photo to engraving artwork, in three steps:
 *
 *   1. Photo edit (AI, batched): remove the background, paint out anything
 *      that is not the subject, correct and sharpen. Still a photograph; no
 *      re-posing. Face Pendant is then cut to the head along a jawline found
 *      by a text call (lib/jawline.ts).
 *   2. Ink trace (lib/ink-filter.ts, no AI): a comic ink filter on that
 *      photo. Every line in it is an edge of the real photograph, so it fixes
 *      the likeness; faces are traced exactly, clothing cleaned for metal.
 *   3. Inking (AI, batched): the trace is redrawn as a clean pen-and-ink
 *      illustration (sketch-prompts.ts INK_PROMPT). It works OVER the trace,
 *      the way a comic inker works over pencils, and sees the photo only to
 *      read expressions and marks.
 *
 * An earlier drawing step was handed the photograph and drew from it, and it
 * drew people who were not there — a different face, a different saree, a
 * bindi on a woman who wears none. The trace in step 2 is what stops that:
 * it decides where every line goes before any model draws one.
 *
 * The photo edit runs live (seconds); the inking is a batch job at half
 * price, so the browser polls for it (app/api/sketch/route.ts): `startSketch`
 * does the edit and the trace and submits the inking, then `collectInked`
 * reads it back. Nothing is stored in between.
 */

import sharp from 'sharp';
import { Type } from '@google/genai';
import { generateImageFromImage, generateJsonFromImage, type GenerateImageResult } from './gemini';
import { readImageJob, submitImageJob } from './gemini-batch';
import { cropPhotoToHead, cutBelowJawline } from './image-processing';
import { findJawline, type Jawline } from './jawline';
import { roughInkTrace, type Region } from './ink-filter';
import { roundDilate } from './distance-transform';
import { unmirror } from './orientation';
import type { CategoryId } from './pendant-categories';
import { buildEnhancePrompt, ENHANCE_RETRY_NOTE, INK_PROMPT } from './sketch-prompts';

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

/**
 * The photo edit, run LIVE: about 25 seconds instead of the 1.5 to 7.5
 * minutes the batch queue took, for 6.6 rupees instead of 3.3. It was the
 * worst of the waits. `retry` adds the note for a pet photo that kept a car
 * door.
 */
async function touchUp(input: SketchInput, retry = false): Promise<GenerateImageResult> {
  return generateImageFromImage({
    prompt: retry ? `${buildEnhancePrompt(input.category)}\n\n${ENHANCE_RETRY_NOTE}` : buildEnhancePrompt(input.category),
    images: [{ bytes: input.imageBytes, mimeType: input.mimeType }],
  });
}

/**
 * Face Pendant: the head alone. The jawline is asked of a text model
 * (lib/jawline.ts), which works whatever the photo looks like; only if that
 * fails are the pixel heuristics used, which need shoulders in the frame
 * and a full beard to find anything.
 */
async function cutToHead(edited: Buffer, mimeType: string): Promise<{ photo: Buffer; jaw: Jawline | null }> {
  const jaw = await findJawline(edited, mimeType);
  if (jaw) {
    console.info(`[sketch] face: jawline found (${jaw.points.length} points, ${jaw.keep.length} earrings kept), cutting below it`);
    return { photo: await cutBelowJawline(edited, jaw.points, jaw.keep), jaw };
  }
  console.info('[sketch] face: no usable jawline, using the pixel cut');
  return { photo: await cropPhotoToHead(edited), jaw: null };
}

/**
 * The touched-up photo as the drawing step needs it: unmirrored against the
 * original, and cut to the head for a Face Pendant, with the jawline it was
 * cut along.
 */
async function touchedUpPhoto(
  edited: GenerateImageResult,
  original: Uint8Array,
  category: CategoryId,
): Promise<{ photo: Buffer; jaw: Jawline | null }> {
  const checked = await unmirror(Buffer.from(original), Buffer.from(edited.bytes));
  if (checked.flipped) console.info(`[sketch] ${category}: photo edit came back mirrored, flipped it back`);
  return CROP_TO_HEAD_CATEGORIES.has(category) ? cutToHead(checked.image, 'image/png') : { photo: checked.image, jaw: null };
}

const FACES_PROMPT = `Everything below is on a 0-1000 scale (y down, x right).
Return "people": one entry for EVERY person in this photo, including babies and people partly hidden, each with:
- "head": the bounding box [ymin, xmin, ymax, xmax] of the head, from the top of the hair to the chin or the bottom of the beard, and from ear to ear;
- "hair": that person's hair exactly as it looks in this photo, always covering all three of: its LENGTH; its TEXTURE, which is always one of curly, wavy or straight (say where, if it differs, e.g. "curly on top"); and how it is WORN (loose, tied back, plaited, in a bun, cropped short at the sides). For example "short, curly on top, cropped short at the sides" or "long, straight and smooth, tied back in a bun". Describe only what you can see; do not guess.
- "marks": any mark on that person's forehead or in the parting of their hair — a bindi or pottu, kumkum, sandal paste, a tilak, sindoor — described by its shape, size and place (for example "a small round dot between the eyebrows and a short horizontal line of sandal paste above it"), or exactly "none" if there is none. Look closely at every forehead; do not assume a mark from clothes, jewellery or where someone seems to be from.
- "eyes": whether each eye is open, half-closed or closed in this photo (for example "both open, narrowed in a smile"). A person squinting in a smile has both eyes open.
Return "hands": one bounding box [ymin, xmin, ymax, xmax] for every visible hand. Empty lists when there are none.`;

const FACES_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    people: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          head: { type: Type.ARRAY, items: { type: Type.NUMBER } },
          hair: { type: Type.STRING },
          marks: { type: Type.STRING },
          eyes: { type: Type.STRING },
        },
        required: ['head', 'hair', 'marks', 'eyes'],
      },
    },
    hands: { type: Type.ARRAY, items: { type: Type.ARRAY, items: { type: Type.NUMBER } } },
  },
  required: ['people', 'hands'],
};

/** Each box is grown by this much on every side, so a mark at the hairline or a ring on a finger sits well inside. */
const FACE_MARGIN = 0.15;

/** What the photo shows about one person, stated to the inker as fact. */
interface PersonFacts {
  hair: string;
  marks: string;
  eyes: string;
}

interface Faces {
  /** Heads and hands, traced exactly and never cleaned (lib/ink-filter.ts). */
  regions: Region[];
  /** Each person, left to right, for the inker. */
  people: PersonFacts[];
}

function toRegion(box: unknown): Region | null {
  if (!Array.isArray(box) || box.length !== 4 || !box.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const [top, left, bottom, right] = (box as number[]).map((v) => v / 1000);
  if (right <= left || bottom <= top) return null;
  const mx = (right - left) * FACE_MARGIN;
  const my = (bottom - top) * FACE_MARGIN;
  return { left: left - mx, top: top - my, right: right + mx, bottom: bottom + my };
}

/**
 * Where the faces and hands are, so the ink filter can leave them exactly as
 * traced and clean everything else for engraving (lib/ink-filter.ts) — and
 * what each person's hair looks like, so the inker is told it as a fact.
 * A text call on the edited photo — it looks, it never draws — costing a
 * fraction of a rupee. Anything short of a clean answer returns undefined,
 * which the filter takes as "treat the whole photo as face": the careful way
 * round.
 */
async function findFaces(photo: Buffer): Promise<Faces | undefined> {
  try {
    const answer = (await generateJsonFromImage({ prompt: FACES_PROMPT, image: { bytes: photo, mimeType: 'image/png' }, schema: FACES_SCHEMA })) as {
      people?: { head?: unknown; hair?: unknown; marks?: unknown; eyes?: unknown }[];
      hands?: unknown[];
    } | null;
    const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
    const people = (Array.isArray(answer?.people) ? answer.people : [])
      .map((person) => ({
        region: toRegion(person?.head),
        facts: { hair: text(person?.hair), marks: text(person?.marks), eyes: text(person?.eyes) },
      }))
      .filter((person): person is { region: Region; facts: PersonFacts } => person.region !== null)
      .sort((x, y) => x.region.left + x.region.right - (y.region.left + y.region.right));
    const hands = (Array.isArray(answer?.hands) ? answer.hands : []).map(toRegion).filter((r): r is Region => r !== null);
    const regions = [...people.map((person) => person.region), ...hands];
    if (regions.length === 0) return undefined;
    console.info(
      `[sketch] ${people.length} faces and ${hands.length} hands kept exactly as traced; ${people
        .map((p) => `hair: ${p.facts.hair}; marks: ${p.facts.marks}; eyes: ${p.facts.eyes}`)
        .join(' | ')}`,
    );
    return { regions, people: people.map((person) => person.facts) };
  } catch (error) {
    console.info(`[sketch] could not find the faces, tracing everything as face: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/**
 * What the photo shows about each person — hair, forehead marks, eyes —
 * stated to the inker as fact, person by person. General rules were not
 * enough: a hair rule passed two test runs and the next production run still
 * gave a smooth-haired woman curls; the "never add a mark" rule did not stop
 * a bindi being drawn on a man who wears none, and nothing stopped a
 * squinting smile becoming a wink. Told per person what the photo shows, the
 * model follows it — the lesson of the old bindi check, applied to all three.
 */
function personFacts(people: PersonFacts[]): string {
  if (people.length === 0 || people.some((p) => !p.hair || !p.marks || !p.eyes)) return '';
  const place = (i: number) =>
    people.length === 1 ? 'The person' : i === 0 ? 'The person furthest to the LEFT' : i === people.length - 1 ? 'The person furthest to the RIGHT' : `Person ${i + 1} from the left`;
  return [
    'EACH PERSON, CHECKED AGAINST THE PHOTOGRAPH BEFOREHAND. Draw exactly this for each person and nothing else — not what you think suits them, and not what the person next to them has:',
    ...people.map((p, i) => {
      const marks = /^none\.?$/i.test(p.marks) ? 'NO mark of any kind on the forehead or in the hair parting — leave the forehead completely clean' : `forehead marks: ${p.marks}`;
      return `- ${place(i)}: hair ${p.hair}; ${marks}; eyes ${p.eyes}.`;
    }),
  ].join('\n');
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

/** Width of the head mask carried with a Face Pendant's inking job; see headMask. */
const HEAD_MASK_WIDTH = 256;
/** How far past the photo's own head outline the drawing may reach, as a fraction of its width — room for flyaway hair and a line drawn a touch wide. */
const HEAD_MASK_MARGIN = 0.02;
/** A pixel of the cut photo this bright, connected to its border, is background. */
const HEAD_MASK_WHITE = 240;

/**
 * Where the head is, from the cut photo: everything that is not the white
 * background, grown by a small margin. Returned as a tiny PNG in base64 so it
 * can travel inside the inking job's metadata and come back with the result.
 *
 * The photo is cut cleanly at the jaw before anything is drawn, and the trace
 * ends there too — but the inker still drew a man's collar and shirt under
 * his beard. A rule in the prompt had not stopped it, so the drawing is now
 * clipped to the head afterwards, on pixels.
 */
async function headMask(photo: Buffer): Promise<string> {
  const { data, info } = await sharp(photo)
    .flatten({ background: '#ffffff' })
    .resize({ width: HEAD_MASK_WIDTH })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  const n = width * height;
  const background = new Uint8Array(n);
  const stack = new Int32Array(n);
  let top = 0;
  const claim = (i: number) => {
    if (!background[i] && data[i] >= HEAD_MASK_WHITE) {
      background[i] = 1;
      stack[top++] = i;
    }
  };
  for (let x = 0; x < width; x++) { claim(x); claim(n - width + x); }
  for (let y = 0; y < height; y++) { claim(y * width); claim(y * width + width - 1); }
  while (top) {
    const i = stack[--top];
    const x = i % width;
    if (x > 0) claim(i - 1);
    if (x < width - 1) claim(i + 1);
    if (i >= width) claim(i - width);
    if (i < n - width) claim(i + width);
  }
  const subject = new Uint8Array(n);
  for (let i = 0; i < n; i++) subject[i] = background[i] ? 0 : 1;
  const grown = roundDilate(subject, width, height, Math.round(width * HEAD_MASK_MARGIN));
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = grown[i] ? 255 : 0;
  return (await sharp(out, { raw: { width, height, channels: 1 } }).png().toBuffer()).toString('base64');
}

/** Whites out every pixel of `image` that falls outside the head mask. The drawing and the photo share their framing, so the mask is simply stretched to fit. */
async function clipToHead(image: Buffer, mask: string): Promise<Buffer> {
  const { data, info } = await sharp(image).greyscale().raw().toBuffer({ resolveWithObject: true });
  const keep = await sharp(Buffer.from(mask, 'base64')).resize(info.width, info.height, { fit: 'fill' }).greyscale().raw().toBuffer();
  for (let i = 0; i < data.length; i++) if (keep[i] < 128) data[i] = 255;
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 1 } }).png().toBuffer();
}

/** Left under the jawline in the drawing, as a fraction of its height, whatever is drawn there. */
const DRAWING_JAW_MARGIN = 0.006;
/**
 * How far below the jawline a beard may carry on, as a fraction of the
 * drawing's height. The traced line is the model's guess at the bottom of
 * the beard and the inker draws its own beard a little lower in places; a
 * hard cut on the line sliced a man's goatee off in a straight edge.
 */
const DRAWING_BEARD_REACH = 0.035;
/** Half-width of the window ink density is measured over, as a fraction of the drawing's width. */
const BEARD_WINDOW = 0.012;
/**
 * Ink coverage that counts as beard. Stubble and a goatee are a mass of
 * strokes, well over this; a throat line, a collar edge or the side of a
 * neck is one stroke crossing an otherwise empty window, well under it.
 */
const BEARD_DENSITY = 0.4;

/**
 * Whites out the drawing below the jawline the photo was cut along — the
 * chin, or the bottom of the beard. The head mask alone follows the photo's
 * feathered cut and a margin past it, and the inker drew a throat, a collar
 * edge and the start of the neck into that band on a bearded man and on a
 * woman. Just under the line, ink that is still as dense as a beard is kept
 * down to where the beard thins out; lone strokes are not. Only between the
 * line's two ends: outside them the head mask already stops the neck at the
 * ear lobe, and a woman's hair that falls below her jaw has to stay.
 * Earrings hanging below the lobe stay too.
 */
async function clipBelowJaw(image: Buffer, jaw: Jawline): Promise<Buffer> {
  const { data, info } = await sharp(image).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;

  // Summed-area table of ink, for the density of any window in O(1).
  const sums = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += data[y * width + x] < 128 ? 1 : 0;
      sums[(y + 1) * (width + 1) + x + 1] = sums[y * (width + 1) + x + 1] + row;
    }
  }
  const r = Math.max(2, Math.round(width * BEARD_WINDOW));
  const density = (x: number, y: number) => {
    const x0 = Math.max(0, x - r);
    const y0 = Math.max(0, y - r);
    const x1 = Math.min(width, x + r + 1);
    const y1 = Math.min(height, y + r + 1);
    const ink = sums[y1 * (width + 1) + x1] - sums[y0 * (width + 1) + x1] - sums[y1 * (width + 1) + x0] + sums[y0 * (width + 1) + x0];
    return ink / ((x1 - x0) * (y1 - y0));
  };

  const points = jaw.points.map((p) => ({ x: p.x * (width - 1), y: p.y * (height - 1) }));
  const margin = height * DRAWING_JAW_MARGIN;
  const reach = height * DRAWING_BEARD_REACH;
  const kept = jaw.keep.map((b) => ({ left: b.left * width, right: b.right * width, top: b.top * height, bottom: b.bottom * height }));
  let segment = 0;
  for (let x = Math.ceil(points[0].x); x <= Math.min(width - 1, points[points.length - 1].x); x++) {
    while (segment < points.length - 2 && points[segment + 1].x < x) segment++;
    const a = points[segment];
    const b = points[segment + 1];
    const lineY = a.y + (b.y - a.y) * (b.x === a.x ? 0 : (x - a.x) / (b.x - a.x));
    let from = Math.max(0, Math.ceil(lineY + margin));
    while (from < height && from < lineY + reach && density(x, from) >= BEARD_DENSITY) from++;
    for (let y = from; y < height; y++) {
      if (kept.some((k) => x >= k.left && x <= k.right && y >= k.top && y <= k.bottom)) continue;
      data[y * width + x] = 255;
    }
  }
  return sharp(data, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

/** Sampling temperature for the inker. See the note where it is used. */
const INK_TEMPERATURE = 0.1;

/**
 * Edits the photo (live), traces it and submits the inking as a batch job,
 * returning that job's name. A head-only edit that came back with something
 * still touching the bottom is redone once, here, before anything is traced.
 */
export async function startSketch(input: SketchInput): Promise<string> {
  let edited = await touchUp(input);
  if (HEAD_ONLY_CATEGORIES.has(input.category) && (await leftObjectsBehind(edited))) {
    console.info(`[sketch] ${input.category}: objects left along the bottom after the photo edit, retrying once`);
    edited = await touchUp(input, true);
  }
  const { photo, jaw } = await touchedUpPhoto(edited, input.imageBytes, input.category);
  const faces = await findFaces(photo);
  // A head-only style is all face, so it is traced whole; the hair facts
  // still apply.
  const headOnly = HEAD_ONLY_CATEGORIES.has(input.category) || CROP_TO_HEAD_CATEGORIES.has(input.category);
  const trace = await sharp(await roughInkTrace(photo, headOnly ? undefined : faces?.regions)).median(SMOOTHING_WINDOW).threshold(128).png().toBuffer();
  const facts = faces ? personFacts(faces.people) : '';
  return submitImageJob(
    {
      prompt: facts ? `${INK_PROMPT}\n\n${facts}` : INK_PROMPT,
      images: [
        { bytes: trace, mimeType: 'image/png' },
        { bytes: photo, mimeType: 'image/png' },
      ],
      // 2K, batched. Tested at 1K live to save the wait: it came back heavier
      // in the laser file and dropped both kumkum marks on the temple photo.
      imageSize: '2K',
      // Low, so the same photo draws the same people every time. At the
      // default, one run of the temple couple was faithful and the next gave
      // him a styled quiff and her a longer, older face from the same inputs.
      temperature: INK_TEMPERATURE,
    },
    `inking ${input.category}`,
    CROP_TO_HEAD_CATEGORIES.has(input.category)
      ? { head: await headMask(photo), ...(jaw ? { jaw: JSON.stringify({ points: jaw.points, keep: jaw.keep }) } : {}) }
      : undefined,
  );
}

/**
 * The inked artwork, forced to greyscale. The prompt asks for black ink only,
 * but a red kumkum mark came back faintly red in testing; metal has no
 * colour, so the colour is taken out here rather than trusted to the model.
 */
export async function collectInked(inkJob: string, category: CategoryId): Promise<Buffer> {
  const inked = await readImageJob(inkJob, `inking ${category}`, { count: true });
  const grey = await sharp(Buffer.from(inked.bytes)).flatten({ background: '#ffffff' }).greyscale().png().toBuffer();
  const head = inked.metadata?.head;
  const clipped = head ? await clipToHead(grey, head) : grey;
  const jaw = inked.metadata?.jaw;
  return jaw ? clipBelowJaw(clipped, JSON.parse(jaw) as Jawline) : clipped;
}
