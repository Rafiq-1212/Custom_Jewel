/**
 * POST /api/generate-image
 *
 * Accepts a photograph plus the customer's pendant category (chosen BEFORE
 * generation — it selects which framing/subject-selection prompt Gemini
 * gets, see lib/gemini.ts's `CATEGORY_FRAMING_PROMPTS`) as multipart form
 * data, validates both, sends the image to Gemini as an actual image input
 * exactly once, and returns the resulting master sketch as a data URL. The
 * Gemini API key never leaves this file's process — it is read from
 * `process.env` on the server and is never echoed back in any response.
 *
 * Gemini's raw output is cropped and background-removed (`lib/image-
 * processing.ts`) before it is returned — deterministic pixel arithmetic, not
 * a second AI call. This is what the client receives and stores as
 * `masterSketch`; it is never sent back through Gemini again.
 */

import { GeminiGenerationError, generateLineArt, type GeminiErrorCode } from '@/lib/gemini';
import { makeTransparentMasterSketch } from '@/lib/image-processing';
import { isCategoryId } from '@/lib/pendant-categories';
import { validateImageBytes } from '@/lib/validation';

// The Gemini SDK and Buffer/base64 handling need the Node runtime, not Edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface SuccessResponse {
  success: true;
  image: string;
}

interface ErrorResponse {
  success: false;
  error: string;
}

function ok(image: string): Response {
  return Response.json({ success: true, image } satisfies SuccessResponse);
}

function fail(message: string, status: number): Response {
  return Response.json({ success: false, error: message } satisfies ErrorResponse, { status });
}

export async function POST(request: Request): Promise<Response> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return fail('Unable to read the upload. Please try again.', 400);
  }

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return fail('No image selected.', 400);
  }

  const categoryRaw = formData.get('category');
  if (typeof categoryRaw !== 'string' || !isCategoryId(categoryRaw)) {
    return fail('Please select a pendant category before generating your design.', 400);
  }
  const category = categoryRaw;

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return fail('Unable to read the uploaded image. Please try again.', 400);
  }

  // Declared size/type are just labels the client attached; the bytes are
  // what actually get checked here before anything is sent to Gemini.
  const validation = validateImageBytes(bytes, file.size);
  if (!validation.ok) {
    const status = validation.code === 'TOO_LARGE' ? 413 : 415;
    return fail(validation.message, status);
  }

  try {
    // The one and only Gemini call for this photo.
    const result = await generateLineArt({ imageBytes: bytes, mimeType: file.type, category });

    // Deterministic post-processing, not AI: crop the AI's white margin and
    // turn the remaining background transparent. See lib/image-processing.ts
    // for why this matters — it's what makes "no rectangular boundary,
    // ever" actually true rather than merely usually true. For Face Pendant
    // specifically, also enforces the jaw cutoff the prompt asks for but
    // can't fully guarantee on its own.
    const master = await makeTransparentMasterSketch(Buffer.from(result.bytes), {
      cropBelowJaw: category === 'face',
    });
    const base64 = master.buffer.toString('base64');
    return ok(`data:${master.contentType};base64,${base64}`);
  } catch (error) {
    const geminiError =
      error instanceof GeminiGenerationError
        ? error
        : new GeminiGenerationError('REQUEST_FAILED', error instanceof Error ? error.message : String(error));

    // The technical detail is logged here and only here — the response below
    // carries nothing but the one customer-facing sentence for this code.
    console.error(`[generate-image] ${geminiError.code}: ${geminiError.detail ?? geminiError.message}`);

    const statusByCode: Record<GeminiErrorCode, number> = {
      MISSING_API_KEY: 500,
      INVALID_API_KEY: 502,
      RATE_LIMITED: 429,
      SAFETY_BLOCKED: 422,
      EMPTY_RESPONSE: 502,
      REQUEST_FAILED: 502,
      SERVICE_UNAVAILABLE: 503,
      NETWORK_ERROR: 502,
    };
    const status = statusByCode[geminiError.code];

    return fail(geminiError.message, status);
  }
}
