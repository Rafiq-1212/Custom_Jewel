'use client';

import { authHeaders } from './api-auth';

/**
 * Waiting for a product photo, for the same reason the sketch waits here:
 * the picture is a batch job at half price (lib/gemini-batch.ts), answered
 * when it suits Google rather than inside one request. The browser submits
 * it and then asks every few seconds whether it is ready.
 *
 * Kept out of the component because a poll loop reads the clock, and a React
 * component body has to stay pure.
 */

/** How often to ask, and when to stop asking. */
const POLL_MS = 5000;
const GIVE_UP_MS = 15 * 60_000;

export class MockupError extends Error {}

interface JobResponse {
  success?: boolean;
  job?: string;
  state?: string;
  dataUrl?: string;
  error?: string;
}

async function read(response: Response): Promise<JobResponse> {
  const body = (await response.json().catch(() => null)) as JobResponse | null;
  if (!body || !response.ok || body.success !== true) {
    throw new MockupError(body?.error ?? 'We couldn\'t make the product photo. Please try again.');
  }
  return body;
}

export interface MockupOptions {
  /** A photo already asked for: only waited for. */
  job?: string;
  /** Told the photo's job once it is asked for, so the wait can be picked up again (components/try). */
  onSubmitted?: (job: string) => void;
}

/** Submits the design and returns the finished photograph as a data URL. */
export async function runMockup(design: unknown, options: MockupOptions = {}): Promise<string> {
  let job = options.job;
  if (!job) {
    const submitted = await read(
      await fetch('/api/render-mockup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(design),
      }),
    );
    job = submitted.job;
    if (!job) throw new MockupError('We couldn\'t make the product photo. Please try again.');
    options.onSubmitted?.(job);
  }

  const until = Date.now() + GIVE_UP_MS;
  let failures = 0;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    // A failed status check is asked again, as for the sketch (lib/sketch-client.ts).
    let body: JobResponse;
    try {
      body = await read(
        await fetch(`/api/render-mockup?job=${encodeURIComponent(job)}&material=${encodeURIComponent(String((design as { material?: string }).material ?? ''))}`, {
          headers: authHeaders(),
        }),
      );
      failures = 0;
    } catch (error) {
      if (++failures < 6) continue;
      throw error;
    }
    if (body.state === 'failed') throw new MockupError('The product photo didn\'t come back. Please try again.');
    if (body.state === 'done' && body.dataUrl) return body.dataUrl;
  }
  throw new MockupError('This is taking much longer than it should. Please try again.');
}
