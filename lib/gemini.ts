import { ApiError, FinishReason, GoogleGenAI, Modality } from '@google/genai';
import type { CategoryId } from './pendant-categories';

if (typeof window !== 'undefined') {
  throw new Error('lib/gemini.ts was imported into a browser bundle. This module is server-only.');
}

const MODEL_ID = 'gemini-3.1-flash-image';

const REQUEST_TIMEOUT_MS = 55_000;

/**
 * The base jewellery-sketch requirements — identity, medium, linework,
 * background, output constraints. Unchanged by which category the customer
 * picked; every generation gets all of it. `CATEGORY_FRAMING_PROMPTS` below
 * is spliced in the middle (see `buildLineArtPrompt`), between the identity
 * paragraph and the medium/style paragraph, so subject-selection/framing
 * instructions sit next to the identity rules they most interact with
 * ("preserve both people", "crop to the face only") without disturbing the
 * medium/style/output rules that follow.
 */
/**
 * The sketch style is calibrated against the client's own reference
 * artwork (their production files: pen-and-ink portraits with heavy,
 * textured hair, bold contours and white skin). An earlier "bold vector /
 * solid black fills" prompt produced generic, symmetrical sticker-style
 * faces that lost the likeness — the head turn, the real hair texture, the
 * person — which is the one thing a memorial/portrait pendant can't lose.
 */
const LINE_ART_PROMPT_HEAD = `Transform the provided reference photograph into a black-and-white
pen-and-ink portrait illustration for laser engraving on a small metal
pendant (about 25 mm wide).`;

const LINE_ART_PROMPT_TAIL = `The single most important requirement is a FAITHFUL LIKENESS of each
specific person:
- Reproduce the exact head angle, tilt and turn, the gaze direction, the
  facial proportions, the expression and every distinctive feature exactly
  as they are in the photograph. If a head is turned three-quarter, draw
  it three-quarter. Do NOT rotate faces to frontal, do NOT make them
  symmetrical, do NOT idealise, beautify, age or slim anyone. Someone who
  knows them must recognise them.

Work like a portrait engraver tracing the actual photograph: follow the
real edges and forms in the photo rather than inventing a stylised
version.

Ink technique (a hand-inked portrait with confident, heavy ink — not a
graphic):
- Face, ears, nose, lips, eyelids: bold, clean black contour lines of
  medium-thick weight. Skin stays pure white — no shading on skin, apart
  from a few short contour strokes where a shadow edge defines the form
  (under the cheekbone, beside the nose, under the lower lip).
- Hair, beard, moustache and eyebrows: heavy, dark ink masses built from
  many thick overlapping strokes that follow the direction the hair grows.
  The dark areas should read as mostly black from a distance, with white
  highlight strokes and small white gaps left inside them so the texture
  still reads as hair up close. Never a flat solid silhouette, and never
  thin scratchy hairlines either.
- Solid black for the pupils, the nostrils and the line between the lips.
- Pure black on pure white only: no grey, no gradients, no halftone, no
  stippling, no pencil texture.
- Every stroke must be crisp and thick enough to survive engraving at
  that size — no microscopic detail.
- Clothing, where included: draw the actual garments as they are in the
  photo — collars, folds and any printed pattern (a floral or patterned
  shirt keeps its pattern) — as bold ink line work, simplified only as far
  as engraving needs, never removed or replaced with plain fabric.

Remove the background completely and replace it with plain white.

The result must look like a professional pen-and-ink engraving portrait
— not a cartoon, not a logo, not a sticker, not a caricature, not a
vector avatar, not anime, not a painting, not a 3D render and not a
pencil sketch.

Do not duplicate faces.
Do not add text or a watermark.

Draw ONLY the people themselves, centred on plain white. Do not draw any
pendant, plate, medallion, disc, frame, border, circle, oval, heart or
any other background shape or outline around them — the pendant shape is
added separately later.`;

/**
 * Category-specific subject-selection/framing instructions — what the base
 * prompt above deliberately leaves unspecified. Only categories that
 * describe *content* (how much of the subject to include) have an entry
 * here; `heart`/`round`/`oval` are shape-framing presets with nothing
 * meaningful to tell Gemini, so they fall back to the base prompt's original
 * "preserve the number of people, don't add or remove anyone" behaviour via
 * the generic entry below.
 */
const CATEGORY_FRAMING_PROMPTS: Partial<Record<CategoryId, string>> = {
  face: `Framing for this jewellery sketch: FACE PENDANT — a close, single-face
crop, the tightest framing in the catalogue.

Prioritize the person's recognizable face, head and hair. Crop tightly
around the head ONLY: face, hair, ears and beard. The composition must end at
the jawline/chin (at the bottom of the beard, if there is one) — completely
exclude the neck, throat, shoulders, chest, collar and clothing, and any other
body content, even if more of the body is visible in the reference photo. Do
not extend the artwork downward past the chin/beard. Generate only the
requested close-up head framing, with nothing but clean background below it.`,
  'half-size': `Framing for this jewellery sketch: HALF SIZE PENDANT — chest-up framing,
more of the person than a Face Pendant.

Include the person's head and an appropriate amount of upper body, such as
the shoulders and chest. Do not include the legs or full-body content, even
if visible in the reference photo — crop to a balanced upper-body
composition suitable for a pendant.`,
  couple: `Framing for this jewellery sketch: COUPLE PENDANT — wide enough framing to
keep two people comfortably in frame.

Preserve both people from the reference photo. Create a single, combined
jewellery composition that keeps both people's recognizable faces, hair and
upper-body details, arranged as they are in the photo. Crop CHEST-UP and
tightly around the pair: heads and shoulders close together filling the
frame, with any outstretched arm (e.g. a selfie arm), hands, and everything
below the chest left out. Do not remove either person and do not generate
only one person's face.`,
  family: `Framing for this jewellery sketch: FAMILY PENDANT — the widest framing, for
a group of three or more.

Preserve the family/group members from the reference photo. Create one
combined jewellery composition that arranges all of the relevant people
naturally together as they are in the photo, cropped chest-up and tightly
around the group, keeping recognizable faces and important details for each
person.`,
  pet: `Framing for this jewellery sketch: PET PENDANT — a close crop tuned for a
single pet's head and shoulders.

Focus on the pet from the reference photo. Emphasize the pet's recognizable
head, face, ears and fur, plus an appropriate amount of upper body. Remove
irrelevant background content and do not include unrelated subjects.`,
};

/** Applies when the category has no entry in `CATEGORY_FRAMING_PROMPTS` above. */
const DEFAULT_FRAMING_PROMPT = `Preserve the number of people in the original photograph.

Do not add additional people.
Do not remove people.`;

function buildLineArtPrompt(category: CategoryId): string {
  const framing = CATEGORY_FRAMING_PROMPTS[category] ?? DEFAULT_FRAMING_PROMPT;
  return `${LINE_ART_PROMPT_HEAD}\n\n${framing}\n\n${LINE_ART_PROMPT_TAIL}`;
}

export type GeminiErrorCode =
  | 'MISSING_API_KEY'
  | 'INVALID_API_KEY'
  | 'RATE_LIMITED'
  | 'SAFETY_BLOCKED'
  | 'EMPTY_RESPONSE'
  | 'REQUEST_FAILED'
  | 'SERVICE_UNAVAILABLE'
  | 'NETWORK_ERROR';

const ERROR_MESSAGES: Record<GeminiErrorCode, string> = {
  MISSING_API_KEY: 'The image generator is not configured yet. Please try again later.',
  INVALID_API_KEY: 'Unable to generate the image. Please try again later.',
  RATE_LIMITED: 'Too many requests right now. Please wait a moment and try again.',
  SAFETY_BLOCKED: 'This photo could not be processed. Please try a different photo.',
  EMPTY_RESPONSE: 'Unable to generate the image. Please try again.',
  REQUEST_FAILED: 'Unable to generate the image. Please try again.',
  SERVICE_UNAVAILABLE: 'The image service is temporarily unavailable. Please try again shortly.',
  NETWORK_ERROR: 'Unable to reach the image service. Please check your connection and try again.',
};

export class GeminiGenerationError extends Error {
  readonly code: GeminiErrorCode;
  readonly detail?: string;

  constructor(code: GeminiErrorCode, detail?: string) {
    super(ERROR_MESSAGES[code]);
    this.name = 'GeminiGenerationError';
    this.code = code;
    this.detail = detail;
  }
}

const SAFETY_FINISH_REASONS = new Set<string>([
  FinishReason.SAFETY,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.BLOCKLIST,
  FinishReason.SPII,
  FinishReason.IMAGE_SAFETY,
]);

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new GeminiGenerationError('MISSING_API_KEY', 'GEMINI_API_KEY is not set in the environment.');
  }
  client ??= new GoogleGenAI({ apiKey });
  return client;
}


function classifyThrown(error: unknown): GeminiGenerationError {
  if (error instanceof GeminiGenerationError) return error;

  if (error instanceof ApiError) {
    const detail = `Gemini API HTTP ${error.status}: ${error.message}`;
    if (error.status === 401 || error.status === 403) {
      return new GeminiGenerationError('INVALID_API_KEY', detail);
    }
    if (error.status === 429) {
      return new GeminiGenerationError('RATE_LIMITED', detail);
    }
    if (error.status >= 500) {
      return new GeminiGenerationError('SERVICE_UNAVAILABLE', detail);
    }
    return new GeminiGenerationError('REQUEST_FAILED', detail);
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(message)) {
    return new GeminiGenerationError('NETWORK_ERROR', message);
  }
  return new GeminiGenerationError('REQUEST_FAILED', message);
}

export interface GenerateLineArtInput {
  imageBytes: Uint8Array;
  mimeType: string;
  /** Which framing/subject-selection prompt to compose with the base prompt. See `buildLineArtPrompt`. */
  category: CategoryId;
}

export interface GenerateLineArtResult {
  bytes: Uint8Array;
  mimeType: string;
}


export async function generateLineArt(
  input: GenerateLineArtInput,
): Promise<GenerateLineArtResult> {
  return generateImageFromImage({
    prompt: buildLineArtPrompt(input.category),
    imageBytes: input.imageBytes,
    mimeType: input.mimeType,
  });
}

export interface GenerateImageFromImageInput {
  prompt: string;
  imageBytes: Uint8Array;
  mimeType: string;
}

/**
 * One image in, one image out. The shared core of both Gemini uses in this
 * app — the photo -> engraving sketch (`generateLineArt`, above) and the flat
 * composite -> photorealistic product mockup (lib/mockup.ts). Same model,
 * same request shape, same typed error classification.
 */
export async function generateImageFromImage(
  input: GenerateImageFromImageInput,
): Promise<GenerateLineArtResult> {
  const ai = getClient();
  const base64Data = Buffer.from(input.imageBytes).toString('base64');

  let response;
  try {
    response = await ai.models.generateContent({
      model: MODEL_ID,
      contents: [
        {
          role: 'user',
          parts: [{ text: input.prompt }, { inlineData: { mimeType: input.mimeType, data: base64Data } }],
        },
      ],
      config: {
        responseModalities: [Modality.TEXT, Modality.IMAGE],
        httpOptions: { timeout: REQUEST_TIMEOUT_MS },
      },
    });
  } catch (error) {
    throw classifyThrown(error);
  }

  if (response.promptFeedback?.blockReason) {
    throw new GeminiGenerationError(
      'SAFETY_BLOCKED',
      `Prompt blocked: ${response.promptFeedback.blockReason}`,
    );
  }

  const candidate = response.candidates?.[0];
  if (!candidate) {
    throw new GeminiGenerationError('EMPTY_RESPONSE', 'Gemini returned no candidates.');
  }
  if (candidate.finishReason && SAFETY_FINISH_REASONS.has(candidate.finishReason)) {
    throw new GeminiGenerationError(
      'SAFETY_BLOCKED',
      `Candidate finishReason: ${candidate.finishReason}`,
    );
  }

  const imagePart = candidate.content?.parts?.find((part) => part.inlineData?.data);
  if (!imagePart?.inlineData?.data) {
    throw new GeminiGenerationError(
      'EMPTY_RESPONSE',
      `No inline image data in response (finishReason: ${candidate.finishReason ?? 'unknown'}).`,
    );
  }

  return {
    bytes: Buffer.from(imagePart.inlineData.data, 'base64'),
    mimeType: imagePart.inlineData.mimeType || 'image/png',
  };
}
