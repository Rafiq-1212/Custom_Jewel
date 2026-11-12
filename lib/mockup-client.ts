'use client';

import { authHeaders } from './api-auth';

/**
 * Where the final gold/silver picture comes from.
 *
 *   'preview' (now): the gold/silver picture of the tool's preview, with its
 *   bail on top, drawn on the server (lib/final-picture.ts) and used as it
 *   is. A second or two, and no second AI call. The shop's experiment from 10 Nov.
 *
 *   'ai': that picture sent to Gemini to be made into a photorealistic
 *   product photo (lib/mockup.ts, /api/render-mockup). Kept, untouched, for
 *   going back: set NEXT_PUBLIC_PRODUCT_PHOTO_FROM=ai on Vercel and redeploy.
 */
export const PRODUCT_PHOTO_FROM: 'preview' | 'ai' = process.env.NEXT_PUBLIC_PRODUCT_PHOTO_FROM === 'ai' ? 'ai' : 'preview';


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
  // A photo already queued with the AI is still collected from it.
  if (PRODUCT_PHOTO_FROM === 'preview' && !options.job) return finalPicture(design, true);
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

/**
 * The design's final gold/silver picture, drawn on the server
 * (/api/product-preview, lib/final-picture.ts) so it is the same on every
 * phone, as a data URL. Saved with the design unless `save` is false.
 */
export async function finalPicture(design: unknown, save: boolean): Promise<string> {
  const body = await read(
    await fetch('/api/product-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ ...(design as object), save }),
    }),
  );
  if (!body.dataUrl) throw new MockupError('We couldn\'t make the picture. Please try again.');
  return body.dataUrl;
}
