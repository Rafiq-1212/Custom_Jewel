/**
 * The sketch, in the three steps a batch job forces it into.
 *
 * Both image calls go to Google's Batch API at half price, which is what
 * takes a finished piece from about 28 rupees to about 14 (lib/gemini-batch.ts).
 * A batch job is answered when it suits Google — 87 seconds for the photo
 * edit and 379 for the 4K drawing, in the two jobs measured — so no request
 * here waits for one. The browser drives it instead:
 *
 *   POST  action=start    submit the photo edit          -> { touchUpJob }
 *   GET   ?job=...        is that job finished yet?      -> { state }
 *   POST  action=advance  read it, trace it, draw it     -> { finishJob }
 *                         (or another touchUpJob, when a pet photo's edit
 *                          left the car door in and has to be redone)
 *   GET   ?job=...        is that one finished yet?
 *   POST  action=collect  read the drawing, finish it    -> { image }
 *
 * Nothing is kept on the server between those calls. The browser holds two
 * job names and the photograph it already has; everything else is read back
 * from the jobs themselves. That is also what makes "draw it again" cheap:
 * it starts at `advance` with the same touch-up job, so the photo edit and
 * the face checks are not paid for twice.
 *
 * The Gemini API key is read from `process.env` on the server and never
 * appears in any response.
 */

import { recordSaving, withCostLog } from '@/lib/cost';
import { GeminiGenerationError, type GeminiErrorCode } from '@/lib/gemini';
import { readJobState } from '@/lib/gemini-batch';
import { makeTransparentMasterSketch } from '@/lib/image-processing';
import { isCategoryId, type CategoryId } from '@/lib/pendant-categories';
import { collectSketch, redrawSaving, startFinish, startTouchUp, type SketchQuality } from '@/lib/sketch-pipeline';
import { validateImageBytes } from '@/lib/validation';

// The Gemini SDK and Buffer/base64 handling need the Node runtime, not Edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// No step waits for a batch job; the longest is `collect`, which downloads a
// 4K image and does the trimming and transparency work on it.
export const maxDuration = 120;

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

interface Labels {
  category: CategoryId;
  quality: SketchQuality;
}

/**
 * The photograph and the two labels every step needs. The photo is sent with
 * each step because each one genuinely uses it: to unmirror the edit against,
 * and to ask about the foreheads. It never leaves this server.
 */
function readLabels(formData: FormData): Labels | Response {
  const categoryRaw = formData.get('category');
  if (typeof categoryRaw !== 'string' || !isCategoryId(categoryRaw)) {
    return fail('Pick a pendant style first, then create the sketch.', 400);
  }
  return { category: categoryRaw, quality: formData.get('quality') === 'draft' ? 'draft' : 'final' };
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

  const labels = readLabels(formData);
  if (labels instanceof Response) return labels;

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

  const input = { ...labels, imageBytes: bytes, mimeType: file.type };
  const action = formData.get('action');

  if (action === 'start') {
    try {
      const touchUpJob = await startTouchUp(input);
      return Response.json({ success: true, stage: 'touch-up', touchUpJob });
    } catch (error) {
      return failFromGemini(error, 'start');
    }
  }

  if (action === 'advance') {
    const touchUpJob = readJobName(formData, 'touchUpJob');
    if (!touchUpJob) return fail('That sketch has expired. Please start it again.', 400);
    const redraw = formData.get('redraw') === '1';
    try {
      return await withCostLog(`sketch ${input.category}/${input.quality}${redraw ? '/redraw' : ''} (batched)`, async () => {
        if (redraw) recordSaving('the photo edit and the face checks', redrawSaving(input.category));
        const step = await startFinish({ ...input, touchUpJob, retried: formData.get('retried') === '1' });
        return Response.json({
          success: true,
          stage: step.finishJob ? 'finish' : 'touch-up',
          touchUpJob: step.touchUpJob ?? touchUpJob,
          finishJob: step.finishJob,
          retried: Boolean(step.touchUpJob),
        });
      });
    } catch (error) {
      return failFromGemini(error, 'advance');
    }
  }

  if (action === 'collect') {
    const touchUpJob = readJobName(formData, 'touchUpJob');
    const finishJob = readJobName(formData, 'finishJob');
    if (!touchUpJob || !finishJob) return fail('That sketch has expired. Please start it again.', 400);
    try {
      return await withCostLog(`collect ${input.category}/${input.quality}`, async () => {
        const sketch = await collectSketch({ ...input, touchUpJob, finishJob });
        // Deterministic post-processing, not AI: crop the AI's white margin
        // and turn the remaining background transparent. For Face Pendant it
        // also enforces the jaw cutoff the prompt asks for but can't
        // guarantee on its own. See lib/image-processing.ts.
        const master = await makeTransparentMasterSketch(sketch, { cropBelowJaw: input.category === 'face' });
        return Response.json({
          success: true,
          image: `data:${master.contentType};base64,${master.buffer.toString('base64')}`,
        });
      });
    } catch (error) {
      return failFromGemini(error, 'collect');
    }
  }

  return fail('Something went wrong making the sketch. Please try again.', 400);
}
