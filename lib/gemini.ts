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
const LINE_ART_PROMPT_HEAD = `Transform the provided reference photograph into a highly detailed
black-and-white jewellery engraving illustration.

Preserve the recognizable facial characteristics, facial proportions,
hairstyles, expressions, pose, and overall appearance of every person
in the reference image.

Do not change the identity or facial structure of the people.`;

const LINE_ART_PROMPT_TAIL = `Convert the photograph into clean monochrome line art suitable for
laser engraving or fine jewellery engraving.

Use precise black outlines, controlled hatching, subtle
cross-hatching, clean facial contours, detailed hair strokes,
and high contrast.

Remove the original background and replace it with a clean white
background.

Simplify unnecessary photographic details while preserving important
facial and clothing characteristics.

The final result should look like professional hand-drawn jewellery
engraving artwork rather than a cartoon, anime image, painting,
3D render, or generic AI portrait.

Do not duplicate faces.
Do not distort facial features.
Do not exaggerate eyes.
Do not alter hairstyles unnecessarily.
Do not add text.
Do not add a watermark.

The final artwork should be centered, clean, high contrast,
monochrome black line artwork on a white background.

The artwork must be suitable for placing inside a custom
jewellery pendant.`;

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
around the head and face ONLY. The composition must end at the jawline/chin
— completely exclude the neck, throat, shoulders, chest, collar and clothing,
and any other body content, even if more of the body is visible in the
reference photo. Do not extend the artwork downward past the chin. Generate
only the requested close-up face framing, with nothing but clean background
below the jaw.`,
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
relevant upper-body details, arranged in a balanced composition. Do not
remove either person and do not generate only one person's face.`,
  family: `Framing for this jewellery sketch: FAMILY PENDANT — the widest framing, for
a group of three or more.

Preserve the family/group members from the reference photo. Create one
combined jewellery composition that arranges all of the relevant people
naturally together, keeping recognizable faces and important details for
each person.`,
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
  const ai = getClient();
  const base64Data = Buffer.from(input.imageBytes).toString('base64');
  const prompt = buildLineArtPrompt(input.category);

  let response;
  try {
    response = await ai.models.generateContent({
      model: MODEL_ID,
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }, { inlineData: { mimeType: input.mimeType, data: base64Data } }],
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
