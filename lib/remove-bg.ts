/**
 * Server-only client for the remove.bg API — used for exactly one thing:
 * Edge Cut → Free Edge Cut's subject boundary. `REMOVE_BG_API_KEY` is read
 * from `process.env` here and never leaves this process; the browser only
 * ever talks to `/api/edge-cut/remove-background` (this module's caller),
 * never to remove.bg directly. Mirrors the error-classification pattern
 * lib/gemini.ts already established (typed error codes, a message table,
 * an HTTP-status classifier) rather than inventing a second convention.
 */

if (typeof window !== 'undefined') {
  throw new Error('lib/remove-bg.ts was imported into a browser bundle. This module is server-only.');
}

const REMOVE_BG_ENDPOINT = 'https://api.remove.bg/v1.0/removebg';
const REQUEST_TIMEOUT_MS = 30_000;

export type RemoveBgErrorCode =
  | 'MISSING_API_KEY'
  | 'INVALID_API_KEY'
  | 'RATE_LIMITED'
  | 'INSUFFICIENT_CREDITS'
  | 'INVALID_IMAGE'
  | 'EMPTY_RESPONSE'
  | 'REQUEST_FAILED'
  | 'SERVICE_UNAVAILABLE'
  | 'NETWORK_ERROR';

const ERROR_MESSAGES: Record<RemoveBgErrorCode, string> = {
  MISSING_API_KEY: 'Free Edge Cut is not configured yet. Please try again later.',
  INVALID_API_KEY: 'Unable to create Free Edge Cut. Please try again later.',
  RATE_LIMITED: 'Too many requests right now. Please wait a moment and try again.',
  INSUFFICIENT_CREDITS: 'Unable to create Free Edge Cut right now. Please try again later.',
  INVALID_IMAGE: 'Unable to create Free Edge Cut from this sketch. Please try a different photo.',
  EMPTY_RESPONSE: 'Unable to create Free Edge Cut. Please try again.',
  REQUEST_FAILED: 'Unable to create Free Edge Cut. Please try again.',
  SERVICE_UNAVAILABLE: 'The background removal service is temporarily unavailable. Please try again shortly.',
  NETWORK_ERROR: 'Unable to reach the background removal service. Please check your connection and try again.',
};

export class RemoveBgError extends Error {
  readonly code: RemoveBgErrorCode;
  readonly detail?: string;

  constructor(code: RemoveBgErrorCode, detail?: string) {
    super(ERROR_MESSAGES[code]);
    this.name = 'RemoveBgError';
    this.code = code;
    this.detail = detail;
  }
}

export interface RemoveBackgroundResult {
  bytes: Buffer;
  mimeType: string;
}

/**
 * Sends `imageBuffer` (expected: an opaque PNG — see the route's own comment
 * on why the master sketch is flattened onto white before it ever reaches
 * this function) to remove.bg and returns its transparent-background PNG.
 */
export async function removeBackground(imageBuffer: Buffer): Promise<RemoveBackgroundResult> {
  const apiKey = process.env.REMOVE_BG_API_KEY;
  if (!apiKey) {
    throw new RemoveBgError('MISSING_API_KEY', 'REMOVE_BG_API_KEY is not set in the environment.');
  }

  const formData = new FormData();
  formData.append('image_file', new Blob([new Uint8Array(imageBuffer)], { type: 'image/png' }), 'sketch.png');
  formData.append('size', 'auto');
  formData.append('format', 'png');

  let response: Response;
  try {
    response = await fetch(REMOVE_BG_ENDPOINT, {
      method: 'POST',
      headers: { 'X-Api-Key': apiKey },
      body: formData,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RemoveBgError('NETWORK_ERROR', message);
  }

  if (!response.ok) {
    let detail = `remove.bg HTTP ${response.status}`;
    try {
      detail += `: ${JSON.stringify(await response.json())}`;
    } catch {
      // Body wasn't JSON (or was empty) — the status code alone is still useful.
    }
    if (response.status === 400) throw new RemoveBgError('INVALID_IMAGE', detail);
    if (response.status === 403) throw new RemoveBgError('INVALID_API_KEY', detail);
    if (response.status === 402) throw new RemoveBgError('INSUFFICIENT_CREDITS', detail);
    if (response.status === 429) throw new RemoveBgError('RATE_LIMITED', detail);
    if (response.status >= 500) throw new RemoveBgError('SERVICE_UNAVAILABLE', detail);
    throw new RemoveBgError('REQUEST_FAILED', detail);
  }

  const arrayBuffer = await response.arrayBuffer();
  const bytes = Buffer.from(arrayBuffer);
  if (bytes.length === 0) {
    throw new RemoveBgError('EMPTY_RESPONSE', 'remove.bg returned an empty body.');
  }

  return { bytes, mimeType: response.headers.get('content-type') || 'image/png' };
}
