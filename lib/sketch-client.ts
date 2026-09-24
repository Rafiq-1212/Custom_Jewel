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

async function post(body: FormData): Promise<Record<string, unknown>> {
  const response = await fetch('/api/sketch', { method: 'POST', body });
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!json || !response.ok || json.success !== true) {
    throw new SketchError(typeof json?.error === 'string' ? json.error : 'Something went wrong making the sketch. Please try again.');
  }
  return json;
}

/** Waits for one job, checking every few seconds. Returns false if the run was cancelled. */
async function waitFor(job: string, cancelled: () => boolean): Promise<boolean> {
  const until = Date.now() + GIVE_UP_MS;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    if (cancelled()) return false;
    const response = await fetch(`/api/sketch?job=${encodeURIComponent(job)}`);
    const json = (await response.json().catch(() => null)) as { success?: boolean; state?: string; error?: string } | null;
    if (!json || !response.ok || json.success !== true) {
      throw new SketchError(typeof json?.error === 'string' ? json.error : 'We lost track of this sketch. Please try again.');
    }
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

/** The finished artwork as a data URL, or null if the run was cancelled. */
export async function runSketch(request: SketchRequest): Promise<string | null> {
  const form = (action: string, extra: Record<string, string> = {}): FormData => {
    const data = new FormData();
    data.set('action', action);
    data.set('file', request.file);
    data.set('category', request.category);
    for (const [key, value] of Object.entries(extra)) data.set(key, value);
    return data;
  };

  request.onStage('touching-up');
  let touchUpJob = String((await post(form('start'))).touchUpJob);
  if (!(await waitFor(touchUpJob, request.cancelled))) return null;

  // `advance` normally submits the inking, but for a head-only style it can
  // come back with a second photo edit instead, when the first one left an
  // object along the bottom. Then this waits again and asks once more.
  request.onStage('inking');
  let step = await post(form('advance', { touchUpJob }));
  if (step.stage === 'touch-up') {
    touchUpJob = String(step.touchUpJob);
    request.onStage('touching-up');
    if (!(await waitFor(touchUpJob, request.cancelled))) return null;
    request.onStage('inking');
    step = await post(form('advance', { touchUpJob, retried: '1' }));
  }
  const inkJob = String(step.inkJob ?? '');
  if (!inkJob) throw new SketchError('Something went wrong making the sketch. Please try again.');
  if (!(await waitFor(inkJob, request.cancelled))) return null;

  request.onStage('finishing');
  const done = await post(form('collect', { inkJob }));
  if (request.cancelled()) return null;
  return String(done.image);
}
