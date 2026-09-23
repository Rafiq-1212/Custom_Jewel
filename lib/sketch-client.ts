'use client';

/**
 * Driving the sketch from the browser, because the server cannot wait for it.
 *
 * Both image calls are batch jobs at half price (lib/gemini-batch.ts), and a
 * batch job is answered when it suits Google: 87 seconds for the photo edit
 * and 379 for the 4K drawing, in the two jobs measured. No serverless request
 * can sit through that, so the waiting happens here — a small poll every few
 * seconds while the page shows what stage the work is at.
 *
 * All this holds between steps is two job names and the photo the operator
 * already chose. Nothing is stored on the server, so a sketch cannot be lost
 * to an instance restart; the job names are the whole state, and they are
 * what makes "draw it again" cheap — the same photo-edit job is handed back
 * and only the drawing is paid for a second time.
 */

import type { SketchQuality } from './pendant-storage';

/** What the operator is told is happening. */
export type SketchStage = 'touching-up' | 'drawing' | 'finishing';

export interface SketchRun {
  image: string;
  /** Hand this back as `redrawFrom` to redraw without paying for the photo edit again. */
  touchUpJob: string;
}

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
  quality: SketchQuality;
  /** A finished photo-edit job to reuse — a redraw of the same photograph. */
  redrawFrom?: string;
  onStage: (stage: SketchStage) => void;
  /** Checked between every step, so a superseded run stops instead of finishing invisibly. */
  cancelled: () => boolean;
}

export async function runSketch(request: SketchRequest): Promise<SketchRun | null> {
  const form = (action: string, extra: Record<string, string> = {}): FormData => {
    const data = new FormData();
    data.set('action', action);
    data.set('file', request.file);
    data.set('category', request.category);
    data.set('quality', request.quality);
    for (const [key, value] of Object.entries(extra)) data.set(key, value);
    return data;
  };

  let touchUpJob = request.redrawFrom;
  if (!touchUpJob) {
    request.onStage('touching-up');
    touchUpJob = String((await post(form('start'))).touchUpJob);
    if (!(await waitFor(touchUpJob, request.cancelled))) return null;
  }

  // `advance` normally submits the drawing, but for a head-only style it can
  // come back with a second photo edit instead, when the first one left an
  // object along the bottom. Then this waits again and asks once more.
  request.onStage('drawing');
  let step: Record<string, unknown>;
  try {
    step = await post(form('advance', { touchUpJob, ...(request.redrawFrom ? { redraw: '1' } : {}) }));
  } catch (error) {
    // A reused photo edit that Google no longer has is not worth an error
    // message: start the whole thing again, which costs what it always did.
    if (!request.redrawFrom) throw error;
    return runSketch({ ...request, redrawFrom: undefined });
  }
  if (step.stage === 'touch-up') {
    touchUpJob = String(step.touchUpJob);
    request.onStage('touching-up');
    if (!(await waitFor(touchUpJob, request.cancelled))) return null;
    request.onStage('drawing');
    step = await post(form('advance', { touchUpJob, retried: '1' }));
  }

  const finishJob = String(step.finishJob ?? '');
  if (!finishJob) throw new SketchError('Something went wrong making the sketch. Please try again.');
  if (!(await waitFor(finishJob, request.cancelled))) return null;

  request.onStage('finishing');
  const done = await post(form('collect', { touchUpJob, finishJob }));
  if (request.cancelled()) return null;
  return { image: String(done.image), touchUpJob };
}
