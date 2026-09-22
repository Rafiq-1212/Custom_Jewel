/**
 * POST /api/generate-image
 *
 * Accepts the (already cropped) photograph plus the pendant style as
 * multipart form data, validates both, and returns the finished sketch as a
 * data URL. The sketch is made in three steps, the same ones the client uses
 * by hand: an AI photo edit (background removed, framing applied, enhanced),
 * a comic ink filter on that photo, and an AI finish that cleans up the trace
 * without moving its lines. See lib/sketch-pipeline.ts.
 *
 * The result is then trimmed and given a transparent background
 * (lib/image-processing.ts) before it is returned. This is what the browser
 * keeps as `masterSketch`; it is never sent back through the AI.
 *
 * The Gemini API key is read from `process.env` on the server and never
 * appears in any response.
 */

import { withCostLog } from '@/lib/cost';
import { GeminiGenerationError, type GeminiErrorCode } from '@/lib/gemini';
import { makeTransparentMasterSketch } from '@/lib/image-processing';
import { isCategoryId } from '@/lib/pendant-categories';
import { createSketch, type SketchQuality } from '@/lib/sketch-pipeline';
import { validateImageBytes } from '@/lib/validation';

// The Gemini SDK and Buffer/base64 handling need the Node runtime, not Edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Two AI calls at 2K plus the ink filter; usually well under a minute.
export const maxDuration = 240;

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
    return fail('We couldn\'t read that upload. Please try again.', 400);
  }

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return fail('Please choose a photo.', 400);
  }

  const categoryRaw = formData.get('category');
  if (typeof categoryRaw !== 'string' || !isCategoryId(categoryRaw)) {
    return fail('Pick a pendant style first, then create the sketch.', 400);
  }
  const category = categoryRaw;

  // Draft mode finishes the drawing at 2K instead of 4K: cheaper and quicker,
  // for judging a photo before paying for the real thing. Anything other than
  // the word "draft" — including nothing at all — is a final sketch, so an
  // older client that sends no quality field still gets full quality.
  const quality: SketchQuality = formData.get('quality') === 'draft' ? 'draft' : 'final';

  // A redraw reuses the touched-up photo from the earlier attempt unless the
  // operator asked for the photo itself to be done again (lib/photo-cache.ts).
  const redoPhotoEdit = formData.get('photoEdit') === 'redo';

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return fail('We couldn\'t read that photo. Please try again.', 400);
  }

  // Declared size/type are just labels the client attached; the bytes are
  // what actually get checked here before anything is sent to Gemini.
  const validation = validateImageBytes(bytes, file.size);
  if (!validation.ok) {
    const status = validation.code === 'TOO_LARGE' ? 413 : 415;
    return fail(validation.message, status);
  }

  try {
    // Enhance, rough ink trace, finish. See lib/sketch-pipeline.ts. The
    // wrapper adds up what this request spent and logs one line for it.
    const sketch = await withCostLog(`sketch ${category}/${quality}${redoPhotoEdit ? '/redo' : ''}`, () =>
      createSketch({ imageBytes: bytes, mimeType: file.type, category, quality, redoPhotoEdit }),
    );

    // Deterministic post-processing, not AI: crop the AI's white margin and
    // turn the remaining background transparent. See lib/image-processing.ts
    // for why this matters — it's what makes "no rectangular boundary,
    // ever" actually true rather than merely usually true. For Face Pendant
    // specifically, also enforces the jaw cutoff the prompt asks for but
    // can't fully guarantee on its own.
    const master = await makeTransparentMasterSketch(sketch, {
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
