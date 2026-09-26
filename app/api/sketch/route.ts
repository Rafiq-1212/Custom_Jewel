/**
 * The sketch, in two requests and a wait.
 *
 * The photo edit runs live, in about 25 seconds, and is traced at once; the
 * inking is sent to Google's Batch API at half price (lib/gemini-batch.ts),
 * answered in two to four minutes in the jobs measured, so the browser polls
 * for it. lib/sketch-pipeline.ts explains the steps.
 *
 *   POST  action=start    edit, trace, submit inking  -> { inkJob }
 *   GET   ?job=...        is the inking finished?     -> { state }
 *   POST  action=collect  read the inked artwork      -> { image }
 *
 * Nothing is kept on the server between those calls. The browser holds the
 * job name and the photograph it already has.
 *
 * The Gemini API key is read from `process.env` on the server and never
 * appears in any response.
 */

import { withCostLog } from '@/lib/cost';
import { GeminiGenerationError, type GeminiErrorCode } from '@/lib/gemini';
import { readJobState } from '@/lib/gemini-batch';
import { makeTransparentMasterSketch } from '@/lib/image-processing';
import { isCategoryId, type CategoryId } from '@/lib/pendant-categories';
import { collectInked, startSketch } from '@/lib/sketch-pipeline';
import { validateImageBytes } from '@/lib/validation';

// The Gemini SDK and Buffer/base64 handling need the Node runtime, not Edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// `start` holds the live photo edit (about 25 s, twice for a pet photo that
// needs a second edit), the face check and the trace; nothing waits for a
// batch job.
export const maxDuration = 300;

/** A job name as the API returns it, e.g. "batches/10mxub2qlici15wtzbvux1lai3y56v3yyv7n". */
const JOB_NAME = /^batches\/[A-Za-z0-9_-]{1,128}$/;

interface ErrorResponse {
  success: false;
  error: string;
}

function fail(message: string, status: number): Response {
  return Response.json({ success: false, error: message } satisfies ErrorResponse, { status });
}

function failFromGemini(error: unknown, where: string): Response {
  const geminiError =
    error instanceof GeminiGenerationError
      ? error
      : new GeminiGenerationError('REQUEST_FAILED', error instanceof Error ? error.message : String(error));
  // The technical detail is logged here and only here; the response carries
  // nothing but the one customer-facing sentence for this code.
  console.error(`[sketch ${where}] ${geminiError.code}: ${geminiError.detail ?? geminiError.message}`);
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
  return fail(geminiError.message, statusByCode[geminiError.code]);
}

/**
 * The photo is sent with each step because each one genuinely uses it: the
 * edit is checked against it for an accidental mirror. It never leaves this
 * server.
 */
function readCategory(formData: FormData): CategoryId | Response {
  const categoryRaw = formData.get('category');
  if (typeof categoryRaw !== 'string' || !isCategoryId(categoryRaw)) {
    return fail('Pick a pendant style first, then create the sketch.', 400);
  }
  return categoryRaw;
}

function readJobName(formData: FormData, field: string): string | null {
  const value = formData.get(field);
  return typeof value === 'string' && JOB_NAME.test(value) ? value : null;
}

/** GET /api/sketch?job=batches/... — has this job finished? */
export async function GET(request: globalThis.Request): Promise<Response> {
  const name = new URL(request.url).searchParams.get('job');
  if (!name || !JOB_NAME.test(name)) return fail('That job does not exist.', 400);
  try {
    return Response.json({ success: true, state: await readJobState(name) });
  } catch (error) {
    return failFromGemini(error, 'state');
  }
}

export async function POST(request: globalThis.Request): Promise<Response> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return fail('We couldn\'t read that upload. Please try again.', 400);
  }

  const category = readCategory(formData);
  if (category instanceof Response) return category;

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) return fail('Please choose a photo.', 400);

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
    return fail(validation.message, validation.code === 'TOO_LARGE' ? 413 : 415);
  }

  const input = { category, imageBytes: bytes, mimeType: file.type };
  const action = formData.get('action');

  if (action === 'start') {
    try {
      return await withCostLog(`sketch ${category}`, async () => {
        const inkJob = await startSketch(input);
        return Response.json({ success: true, stage: 'inking', inkJob });
      });
    } catch (error) {
      return failFromGemini(error, 'start');
    }
  }

  if (action === 'collect') {
    const inkJob = readJobName(formData, 'inkJob');
    if (!inkJob) return fail('That sketch has expired. Please start it again.', 400);
    try {
      return await withCostLog(`inking ${category} (batched)`, async () => {
        // Deterministic post-processing, not AI: crop the white margin and
        // turn the background transparent. For Face Pendant it also enforces
        // the jaw cutoff. See lib/image-processing.ts.
        const master = await makeTransparentMasterSketch(await collectInked(inkJob, category), { cropBelowJaw: category === 'face' });
        return Response.json({
          success: true,
          stage: 'done',
          image: `data:${master.contentType};base64,${master.buffer.toString('base64')}`,
        });
      });
    } catch (error) {
      return failFromGemini(error, 'collect');
    }
  }

  return fail('Something went wrong making the sketch. Please try again.', 400);
}
