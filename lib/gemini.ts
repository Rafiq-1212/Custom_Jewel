import { ApiError, FinishReason, GoogleGenAI, Modality } from '@google/genai';
import { priceImageCall, priceTextCall, recordCall } from './cost';

if (typeof window !== 'undefined') {
  throw new Error('lib/gemini.ts was imported into a browser bundle. This module is server-only.');
}

export const MODEL_ID = 'gemini-3.1-flash-image';
/**
 * Text model for questions about a photo whose answer is data, not a picture
 * (lib/jawline.ts). Thinking is switched off: measured on the jawline
 * question it made no visible difference to the answer and took the call
 * from about 8 seconds to about 3.
 */
const TEXT_MODEL_ID = 'gemini-3.6-flash';
const TEXT_REQUEST_TIMEOUT_MS = 30_000;

/** Per request. A 4K finish from the sketch pipeline takes around a minute, sometimes longer. */
const REQUEST_TIMEOUT_MS = 150_000;

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
  MISSING_API_KEY: 'The sketch maker isn\'t set up yet. Please try again later.',
  INVALID_API_KEY: 'Something went wrong on our side. Please try again later.',
  RATE_LIMITED: 'We\'re a bit busy right now. Please wait a moment and try again.',
  SAFETY_BLOCKED: 'We can\'t use this photo. Please try a different one.',
  EMPTY_RESPONSE: 'Something went wrong making the image. Please try again.',
  REQUEST_FAILED: 'Something went wrong making the image. Please try again.',
  SERVICE_UNAVAILABLE: 'The service is down for a moment. Please try again shortly.',
  NETWORK_ERROR: 'We couldn\'t connect. Check your internet and try again.',
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


export function classifyThrown(error: unknown): GeminiGenerationError {
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

export interface GenerateImageResult {
  bytes: Uint8Array;
  mimeType: string;
}

export interface GenerateImageFromImageInput {
  prompt: string;
  /** One or more input images, sent in order after the prompt. */
  images: { bytes: Uint8Array; mimeType: string }[];
  /**
   * Output size of the longest side: "1K" (the model default), "2K" or "4K".
   * Larger sizes keep fine detail such as hair strands and eyelashes, at the
   * cost of time.
   */
  imageSize?: '1K' | '2K' | '4K';
}

/**
 * Images in, one image out. Shared by every Gemini use in this app: the two
 * steps of the sketch pipeline (lib/sketch-pipeline.ts) and the product photo
 * (lib/mockup.ts). Same model, same request shape, same typed errors.
 */
export async function generateImageFromImage(
  input: GenerateImageFromImageInput,
): Promise<GenerateImageResult> {
  const ai = getClient();

  let response;
  try {
    response = await ai.models.generateContent({
      model: MODEL_ID,
      contents: [
        {
          role: 'user',
          parts: [
            { text: input.prompt },
            ...input.images.map((image) => ({
              inlineData: { mimeType: image.mimeType, data: Buffer.from(image.bytes).toString('base64') },
            })),
          ],
        },
      ],
      config: {
        responseModalities: [Modality.TEXT, Modality.IMAGE],
        ...(input.imageSize ? { imageConfig: { imageSize: input.imageSize } } : {}),
        httpOptions: { timeout: REQUEST_TIMEOUT_MS },
      },
    });
  } catch (error) {
    throw classifyThrown(error);
  }

  // One line per call in the server log, so the real cost of a design can be
  // read straight from Google's own token counts — and added to this
  // request's running total for the summary line (lib/cost.ts).
  const usage = response.usageMetadata;
  if (usage) {
    const details = (usage.candidatesTokensDetails ?? []).map((d) => `${d.modality}=${d.tokenCount}`).join(' ');
    const usd = priceImageCall(usage);
    recordCall(`image ${input.imageSize ?? '1K'}`, usd);
    console.info(
      `[gemini] usage input=${usage.promptTokenCount ?? 0} output=${usage.candidatesTokenCount ?? 0} (${details}) thinking=${usage.thoughtsTokenCount ?? 0} size=${input.imageSize ?? 'default'} cost=$${usd.toFixed(4)}`,
    );
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

export interface GenerateJsonFromImageInput {
  prompt: string;
  image: { bytes: Uint8Array; mimeType: string };
  /** A response schema in the SDK's own format; the answer is parsed JSON that follows it. */
  schema: Record<string, unknown>;
}

/**
 * One image in, JSON out. Never returns a picture, so it cannot alter the
 * photo it is asked about. Throws the same typed errors as the image call.
 */
export async function generateJsonFromImage(input: GenerateJsonFromImageInput): Promise<unknown> {
  const ai = getClient();
  let response;
  try {
    response = await ai.models.generateContent({
      model: TEXT_MODEL_ID,
      contents: [
        {
          role: 'user',
          parts: [
            { text: input.prompt },
            { inlineData: { mimeType: input.image.mimeType, data: Buffer.from(input.image.bytes).toString('base64') } },
          ],
        },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: input.schema,
        temperature: 0,
        thinkingConfig: { thinkingBudget: 0 },
        httpOptions: { timeout: TEXT_REQUEST_TIMEOUT_MS },
      },
    });
  } catch (error) {
    throw classifyThrown(error);
  }

  const usage = response.usageMetadata;
  if (usage) {
    const usd = priceTextCall(usage);
    recordCall('text', usd);
    console.info(`[gemini] usage input=${usage.promptTokenCount ?? 0} output=${usage.candidatesTokenCount ?? 0} (TEXT) thinking=${usage.thoughtsTokenCount ?? 0} model=${TEXT_MODEL_ID} cost=$${usd.toFixed(4)}`);
  }

  const text = response.text;
  if (!text) throw new GeminiGenerationError('EMPTY_RESPONSE', 'The text model returned nothing.');
  try {
    return JSON.parse(text);
  } catch {
    throw new GeminiGenerationError('REQUEST_FAILED', 'The text model did not return valid JSON.');
  }
}
