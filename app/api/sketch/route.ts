/**
 * The sketch, in two requests and a wait.
 *
 * The photo edit runs live, in about 25 seconds, and is traced at once; the
 * inking is sent to Google's Batch API at half price (lib/gemini-batch.ts),
 * answered in two to four minutes in the jobs measured, so the browser polls
 * for it. lib/sketch-pipeline.ts explains the steps.
 *
 *   POST  action=start    edit, trace, submit inking  -> { inkJob }
 *   POST  action=redraw   the same inking again, with   -> { inkJob }
 *                         the corrections in a piece
 *                         of feedback (lib/feedback.ts)
 *   GET   ?job=...        is the inking finished?     -> { state }
 *   POST  action=collect  read the inked artwork      -> { image, job, folder },
 *                                                      or { redo: true } once,
 *                                                      if it came back out of frame
 *
 * The browser holds the job name between those calls. The drawing step's
 * inputs are kept for each sketch (lib/ink-inputs.ts), so that a redraw
 * needs no second photo edit.
 *
 * The Gemini API key is read from `process.env` on the server and never
 * appears in any response.
 */

import { after } from 'next/server';
import { archive, orderFolder } from '@/lib/archive';
import { costSoFar, withCostLog } from '@/lib/cost';
import { GeminiGenerationError, type GeminiErrorCode } from '@/lib/gemini';
import { readJobState } from '@/lib/gemini-batch';
import { makeTransparentMasterSketch } from '@/lib/image-processing';
import { isCategoryId, type CategoryId } from '@/lib/pendant-categories';
import { correctionsFrom } from '@/lib/feedback';
import { feedbackFor, linkRedraw } from '@/lib/feedback-store';
import { loadInkInputs, saveInkInputs } from '@/lib/ink-inputs';
import { collectInked, ReframeNeeded, startSketch, submitInking } from '@/lib/sketch-pipeline';
import { collectWhenLeft, uploadOf } from '@/lib/sketch-finish';
import { get } from '@vercel/blob';
import { trackEvent, trackSketchDone, trackSketchFailed, trackSketchFolder, trackSketchStarted, type Who } from '@/lib/tracking';
import { validateImageBytes } from '@/lib/validation';
import { markRedoPending, ownsJob, refundTry, takeTry, takeRedo } from '@/lib/customers';
import { callerOf } from '@/lib/signed-in';

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

/**
 * Why a sketch failed, for the ledger the admin panel reads. The customer
 * sees one plain sentence; the admin needs the cause behind it (on 13 Oct
 * four failures read "Something went wrong" when the Gemini credits had run
 * out).
 */
function failureReason(error: unknown): string {
  const reason =
    error instanceof GeminiGenerationError ? `${error.code}: ${error.detail ?? error.message}` : error instanceof Error ? error.message : String(error);
  return reason.slice(0, 500);
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
  const caller = await callerOf(request);
  if (caller instanceof Response) return caller;
  const name = new URL(request.url).searchParams.get('job');
  if (!name || !JOB_NAME.test(name)) return fail('That job does not exist.', 400);
  if (caller.kind === 'customer' && !(await ownsJob(caller.phone, name))) return fail('That sketch does not exist.', 404);
  try {
    return Response.json({ success: true, state: await readJobState(name) });
  } catch (error) {
    return failFromGemini(error, 'state');
  }
}

/** The photo as sent, checked: bytes, not the label the browser put on them. */
async function readPhoto(formData: FormData): Promise<{ bytes: Uint8Array; type: string } | Response> {
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
  if (!validation.ok) return fail(validation.message, validation.code === 'TOO_LARGE' ? 413 : 415);
  return { bytes, type: file.type };
}

const extensionOf = (type: string | undefined) => (type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg');

/**
 * The photo exactly as uploaded, saved before anything is made from it, in
 * a folder of its own (named from its bytes): a design that fails, or one
 * the customer had no designs left for, can still be made from it later and
 * sent to them. Null if it could not be saved.
 */
function keepUpload(photo: { bytes: Uint8Array; type: string }): Promise<string | null> {
  return archive(orderFolder(photo.bytes), `upload.${extensionOf(photo.type)}`, photo.bytes, photo.type || 'image/jpeg');
}

/** A design that never reached the drawing, kept in the admin panel with its upload and who sent it. */
async function trackUploadOnly(upload: string | null, category: CategoryId, reason: string, who: Who): Promise<void> {
  if (!upload) return trackSketchFailed(undefined, reason, costSoFar(), who);
  const id = `batches/upload-${upload.split('/')[2]}`;
  await trackSketchStarted(id, category, 0, who, undefined, upload);
  await trackSketchFailed(id, reason, costSoFar(), who);
}

export async function POST(request: globalThis.Request): Promise<Response> {
  const caller = await callerOf(request);
  if (caller instanceof Response) return caller;
  const who: Who = caller.kind === 'staff' ? { userId: caller.staff.id, phone: null } : { userId: null, phone: caller.phone };
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return fail('We couldn\'t read that upload. Please try again.', 400);
  }

  const category = readCategory(formData);
  if (category instanceof Response) return category;
  const action = formData.get('action');

  if (action === 'start') {
    const photo = await readPhoto(formData);
    if (photo instanceof Response) return photo;
    const upload = keepUpload(photo);
    // A shop customer spends one of their designs, unless this is the free
    // second go at a drawing that came back out of frame.
    let charged = false;
    if (caller.kind === 'customer') {
      const previous = formData.get('attempt') === '2' ? readJobName(formData, 'previousJob') : null;
      if (!(previous && (await takeRedo(caller.phone, previous)))) {
        if (!(await takeTry(caller.phone))) {
          after(async () => trackUploadOnly(await upload, category, 'The customer had no designs left.', who));
          return Response.json({ success: false, outOfTries: true, error: 'You have used all your designs.' }, { status: 429 });
        }
        charged = true;
      }
    }
    const began = Date.now();
    try {
      return await withCostLog(`sketch ${category}`, async () => {
        let started: Awaited<ReturnType<typeof startSketch>>;
        try {
          started = await startSketch({ category, imageBytes: photo.bytes, mimeType: photo.type });
        } catch (error) {
          if (charged && caller.kind === 'customer') await refundTry(caller.phone);
          await trackUploadOnly(await upload, category, failureReason(error), who);
          throw error;
        }
        await trackSketchStarted(started.job, category, costSoFar(), who, undefined, await upload);
        // Kept so the drawing can be redone from feedback without a second photo edit;
        // then the drawing is waited for here too, and collected if its page has gone (lib/sketch-finish.ts).
        after(async () => {
          await saveInkInputs(started.job, started.inputs);
          await collectWhenLeft(started.job, began + (maxDuration - 15) * 1000);
        });
        return Response.json({ success: true, stage: 'inking', inkJob: started.job });
      });
    } catch (error) {
      return failFromGemini(error, 'start');
    }
  }

  // A drawing done again with the corrections in a piece of feedback
  // (lib/feedback.ts): the same inputs, so no second photo edit.
  if (action === 'redraw') {
    if (caller.kind !== 'staff') return fail('That sketch can\'t be redrawn.', 403);
    const previous = readJobName(formData, 'previousJob');
    const feedbackId = Number(formData.get('feedbackId'));
    if (!previous || !Number.isInteger(feedbackId)) return fail('That sketch can\'t be redrawn. Please make a new one.', 400);
    const said = await feedbackFor(feedbackId, previous);
    if (!said) return fail('Save what was wrong with the sketch first, then redraw it.', 400);
    const inputs = await loadInkInputs(previous);
    if (!inputs) return fail('This sketch was made before redraws were possible. Please make a new one from the photo.', 409);
    const added = correctionsFrom(said);
    if (!added) return fail('Tick what was wrong, or write a note, so the drawing knows what to change.', 400);
    const corrected = { ...inputs, corrections: [inputs.corrections, added].filter(Boolean).join('\n') };
    try {
      return await withCostLog(`redraw ${inputs.category}`, async () => {
        const job = await submitInking(corrected);
        await trackSketchStarted(job, inputs.category, costSoFar(), who, { parent: previous, corrections: corrected.corrections });
        await linkRedraw(feedbackId, job);
        after(() => saveInkInputs(job, corrected));
        return Response.json({ success: true, stage: 'inking', inkJob: job, category: inputs.category });
      });
    } catch (error) {
      return failFromGemini(error, 'redraw');
    }
  }

  // A design made again from the photo it was uploaded with (admin panel,
  // Designs): for one that failed, was left, or came out wrong. It is made for
  // the same customer, at no cost to them, and collected here: nobody's page
  // waits for it.
  if (action === 'remake') {
    if (caller.kind !== 'staff') return fail('That design can\'t be made again.', 403);
    const from = readJobName(formData, 'from');
    const source = from ? await uploadOf(from) : null;
    if (!from || !source || !isCategoryId(source.category)) return fail('That design has no uploaded photo to make it from.', 404);
    const file = await get(source.upload, { access: 'private' }).catch(() => null);
    if (!file || file.statusCode !== 200) return fail('The uploaded photo could not be found.', 404);
    const imageBytes = new Uint8Array(await new Response(file.stream).arrayBuffer());
    const made: Who = { userId: caller.staff.id, phone: source.phone };
    const began = Date.now();
    try {
      return await withCostLog(`remake ${source.category}`, async () => {
        const started = await startSketch({ category: source.category as CategoryId, imageBytes, mimeType: file.blob.contentType });
        await trackSketchStarted(started.job, source.category, costSoFar(), made, { parent: from, corrections: '' }, source.upload);
        after(async () => {
          await saveInkInputs(started.job, started.inputs);
          await collectWhenLeft(started.job, began + (maxDuration - 15) * 1000, 0);
        });
        return Response.json({ success: true, job: started.job });
      });
    } catch (error) {
      return failFromGemini(error, 'remake');
    }
  }

  if (action === 'collect') {
    const inkJob = readJobName(formData, 'inkJob');
    if (!inkJob) return fail('That sketch has expired. Please start it again.', 400);
    if (caller.kind === 'customer' && !(await ownsJob(caller.phone, inkJob))) return fail('That sketch does not exist.', 404);
    // The photo comes with a first drawing, to be kept with it; a redraw has it already.
    const photo = formData.get('file') ? await readPhoto(formData) : null;
    if (photo instanceof Response) return photo;
    try {
      return await withCostLog(`inking ${category} (batched)`, async () => {
        // Deterministic post-processing, not AI: crop the white margin and
        // turn the background transparent (lib/image-processing.ts). A Face
        // Pendant was already clipped to the head in collectInked.
        let inked: Buffer;
        try {
          inked = await collectInked(inkJob, category, { redo: formData.get('attempt') !== '2' });
        } catch (error) {
          if (error instanceof ReframeNeeded) {
            // Drawn once more, free: the next start with previousJob uses this up (lib/customers.ts).
            await markRedoPending(inkJob).catch(() => undefined);
            await trackEvent({ kind: 'sketch_redo', generationId: inkJob, detail: category, costUsd: costSoFar(), ...who });
          } else {
            if (caller.kind === 'customer') await refundTry(caller.phone);
            await trackSketchFailed(inkJob, failureReason(error), costSoFar(), who);
          }
          throw error;
        }
        const master = await makeTransparentMasterSketch(inked);
        // Kept in the cloud with the photo it was made from (lib/archive.ts),
        // once the sketch has gone back: the operator never waits on a save.
        const folder = orderFolder(master.buffer);
        await trackSketchFolder(inkJob, folder);
        const spent = costSoFar();
        after(async () => {
          const [, saved] = await Promise.all([
            photo ? archive(folder, `photo.${extensionOf(photo.type)}`, photo.bytes, photo.type || 'image/jpeg') : null,
            archive(folder, 'sketch.png', master.buffer, 'image/png'),
          ]);
          await trackSketchDone(inkJob, folder, spent, saved, who);
        });
        return Response.json({
          success: true,
          stage: 'done',
          // Which design this is: feedback on it is given against the job.
          job: inkJob,
          folder,
          image: `data:${master.contentType};base64,${master.buffer.toString('base64')}`,
        });
      });
    } catch (error) {
      // Not a failure the operator sees: the browser draws it again.
      if (error instanceof ReframeNeeded) {
        console.info('[sketch collect] drawing came back out of frame, asking the browser to draw it again');
        return Response.json({ success: false, redo: true, error: 'Drawing it again.' }, { status: 409 });
      }
      return failFromGemini(error, 'collect');
    }
  }

  return fail('Something went wrong making the sketch. Please try again.', 400);
}
