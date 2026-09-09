/**
 * POST /api/edge-cut/remove-background
 *
 * Backs Edge Cut → Free Edge Cut only. Not called for Standard Pendant, Edge
 * Cut inside Heart, Bust with Base, Silhouette Band, or any transform/
 * material change — see lib/remove-bg-contour.ts and the effect in
 * app/page.tsx that calls it for exactly when this fires (once per generated
 * sketch, cached after that).
 *
 * Takes the EXISTING masterSketch (never a new AI image — Gemini already ran
 * exactly once in /api/generate-image) and sends it to remove.bg so its
 * subject boundary can be traced into the Free Edge Cut cutting path. The
 * master sketch already has its own background punched to transparent (see
 * lib/image-processing.ts), which is the opposite of what remove.bg needs —
 * it expects a normal opaque image with a real background to strip — so this
 * route flattens it onto white first, the same move lib/laser-export.ts
 * already makes before handing this kind of image to potrace.
 *
 * `REMOVE_BG_API_KEY` is read from `process.env` here and never reaches the
 * client — the browser only ever calls this route, never remove.bg directly.
 */

import sharp from 'sharp';
import { removeBackground, RemoveBgError } from '@/lib/remove-bg';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface RemoveBackgroundRequestBody {
  sketch?: unknown;
}

function fail(message: string, status: number): Response {
  return Response.json({ success: false, error: message }, { status });
}

function decodeDataUrl(dataUrl: string): Buffer {
  const match = /^data:image\/[\w+.-]+;base64,(.+)$/.exec(dataUrl);
  if (!match) throw new Error('Expected a base64 image data URL.');
  return Buffer.from(match[1], 'base64');
}

export async function POST(request: Request): Promise<Response> {
  let body: RemoveBackgroundRequestBody;
  try {
    body = (await request.json()) as RemoveBackgroundRequestBody;
  } catch {
    return fail('Unable to read the request.', 400);
  }

  if (typeof body.sketch !== 'string' || !body.sketch.startsWith('data:image/')) {
    return fail('No sketch to process — generate a sketch first.', 400);
  }

  let sketchBuffer: Buffer;
  try {
    sketchBuffer = decodeDataUrl(body.sketch);
  } catch {
    return fail('Unable to read the sketch image.', 400);
  }

  try {
    const flattened = await sharp(sketchBuffer).flatten({ background: '#ffffff' }).png().toBuffer();
    const { bytes, mimeType } = await removeBackground(flattened);
    const image = `data:${mimeType};base64,${bytes.toString('base64')}`;
    return Response.json({ success: true, image });
  } catch (error) {
    if (error instanceof RemoveBgError) {
      // Developer-facing detail stays server-side; the client only ever
      // sees the safe, generic message already baked into RemoveBgError.
      console.error('[remove-background]', error.code, error.detail ?? error.message);
      const status = error.code === 'MISSING_API_KEY' ? 503 : error.code === 'RATE_LIMITED' ? 429 : 502;
      return fail(error.message, status);
    }
    console.error('[remove-background]', error instanceof Error ? error.message : error);
    return fail('Unable to create Free Edge Cut. Please try again.', 502);
  }
}
