'use client';

/**
 * Driving the sketch from the browser, because the server cannot wait for it.
 *
 * Both AI calls — the photo edit and the inking — are batch jobs at half
 * price (lib/gemini-batch.ts), answered when it suits Google: one to six
 * minutes each in the jobs measured. No serverless request can sit through
 * that, so the waiting happens here, a small poll every few seconds.
 */

/** What the operator is told is happening. */
export type SketchStage = 'touching-up' | 'inking' | 'finishing';

export class SketchError extends Error {}

/** How often the browser asks whether a job has finished. */
const POLL_MS = 5000;
/**
 * A job that has not finished in this long has gone wrong in a way polling
 * will not fix. Google promises an answer within 24 hours, so this is not a
 * statement about the API — it is the point at which an operator deserves to
 * be told to start again rather than watch a spinner.
 */
const GIVE_UP_MS = 20 * 60_000;

/** The server asked for the drawing to be done again (it came back out of frame). */
class RedoSketch extends Error {}

async function post(body: FormData): Promise<Record<string, unknown>> {
  const response = await fetch('/api/sketch', { method: 'POST', body });
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (json?.redo === true) throw new RedoSketch();
  if (!json || !response.ok || json.success !== true) {
    throw new SketchError(typeof json?.error === 'string' ? json.error : 'Something went wrong making the sketch. Please try again.');
  }
  return json;
}

/**
 * A status check that fails is asked again; only this many failures in a row
 * end the run. One "fetch failed" between the server and Google used to throw
 * away a sketch that was minutes along and still running fine.
 */
const MAX_FAILED_CHECKS = 6;

/** Waits for one job, checking every few seconds. Returns false if the run was cancelled. */
async function waitFor(job: string, cancelled: () => boolean): Promise<boolean> {
  const until = Date.now() + GIVE_UP_MS;
  let failures = 0;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    if (cancelled()) return false;
    const response = await fetch(`/api/sketch?job=${encodeURIComponent(job)}`).catch(() => null);
    const json = (await response?.json().catch(() => null)) as { success?: boolean; state?: string; error?: string } | null;
    if (!response || !json || !response.ok || json.success !== true) {
      if (++failures < MAX_FAILED_CHECKS) continue;
      throw new SketchError(typeof json?.error === 'string' ? json.error : 'We lost track of this sketch. Please try again.');
    }
    failures = 0;
    if (json.state === 'done') return true;
    if (json.state === 'failed') throw new SketchError('The sketch didn\'t come back. Please try again.');
  }
  throw new SketchError('This is taking much longer than it should. Please try again.');
}

export interface SketchRequest {
  file: File;
  category: string;
  onStage: (stage: SketchStage) => void;
  /** Checked between every step, so a superseded run stops instead of finishing invisibly. */
  cancelled: () => boolean;
}

/** A finished drawing: the artwork as a data URL, and the design it is (its job), which feedback is given against. */
export interface Sketch {
  image: string;
  job: string;
}

/**
 * The finished drawing, or null if the run was cancelled. A Face Pendant
 * drawing that came back out of frame is started over once; the second
 * attempt is told so, and is kept whatever its framing.
 */
export async function runSketch(request: SketchRequest, attempt = 1): Promise<Sketch | null> {
  try {
    return await sketchOnce(request, attempt);
  } catch (error) {
    if (error instanceof RedoSketch && attempt === 1 && !request.cancelled()) return runSketch(request, 2);
    throw error;
  }
}

async function sketchOnce(request: SketchRequest, attempt: number): Promise<Sketch | null> {
  const form = (action: string, extra: Record<string, string> = {}): FormData => {
    const data = new FormData();
    data.set('action', action);
    data.set('attempt', String(attempt));
    data.set('file', request.file);
    data.set('category', request.category);
    for (const [key, value] of Object.entries(extra)) data.set(key, value);
    return data;
  };

  // `start` edits the photo live and submits the inking; only the inking
  // is waited for here.
  request.onStage('touching-up');
  const inkJob = String((await post(form('start'))).inkJob ?? '');
  if (!inkJob) throw new SketchError('Something went wrong making the sketch. Please try again.');
  request.onStage('inking');
  if (!(await waitFor(inkJob, request.cancelled))) return null;

  request.onStage('finishing');
  const done = await post(form('collect', { inkJob }));
  if (request.cancelled()) return null;
  return { image: String(done.image), job: String(done.job ?? inkJob) };
}

export interface RedrawRequest {
  /** The drawing being corrected. */
  previousJob: string;
  /** The 👎 saved against it, whose ticks and note are the corrections. */
  feedbackId: number;
  category: string;
  onStage: (stage: SketchStage) => void;
  cancelled: () => boolean;
}

/**
 * The same drawing done again with the shop's corrections (lib/feedback.ts):
 * no photo, no photo edit, the drawing step alone. Not redone if it comes
 * back out of frame: it is kept as it is, like a second attempt.
 */
export async function runRedraw(request: RedrawRequest): Promise<Sketch | null> {
  const form = (action: string, extra: Record<string, string>): FormData => {
    const data = new FormData();
    data.set('action', action);
    data.set('attempt', '2');
    data.set('category', request.category);
    for (const [key, value] of Object.entries(extra)) data.set(key, value);
    return data;
  };
  request.onStage('inking');
  const started = await post(form('redraw', { previousJob: request.previousJob, feedbackId: String(request.feedbackId) }));
  const inkJob = String(started.inkJob ?? '');
  if (!inkJob) throw new SketchError('Something went wrong redrawing the sketch. Please try again.');
  if (!(await waitFor(inkJob, request.cancelled))) return null;
  request.onStage('finishing');
  const done = await post(form('collect', { inkJob }));
  if (request.cancelled()) return null;
  return { image: String(done.image), job: String(done.job ?? inkJob) };
}
