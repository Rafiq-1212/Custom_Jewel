/**
 * POST /api/render-mockup
 *
 * Turns the current design into a photorealistic product photograph via
 * Gemini — see lib/mockup.ts for why this second AI call exists and what it
 * is (and isn't) allowed to change. Runs only when the operator explicitly
 * asks for a mockup of a specific metal; the live preview never calls it.
 *
 * Same request body as /api/export-laser (lib/design-request.ts), so the
 * mockup and the manufacturing files always describe the same pendant.
 */

import { parseDesignRequest } from '@/lib/design-request';
import { GeminiGenerationError } from '@/lib/gemini';
import { renderPendantMockup } from '@/lib/mockup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function fail(message: string, status: number): Response {
  return Response.json({ success: false, error: message }, { status });
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail('Unable to read the request.', 400);
  }

  const parsed = parseDesignRequest(body);
  if (!parsed.ok) return fail(parsed.error, 400);

  try {
    const result = await renderPendantMockup(parsed.value);
    return Response.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof GeminiGenerationError) {
      // Technical detail stays in the server log; the browser gets the one
      // customer-facing sentence for this code, same as /api/generate-image.
      console.error(`[render-mockup] ${error.code}: ${error.detail ?? error.message}`);
      const status = error.code === 'RATE_LIMITED' ? 429 : error.code === 'SAFETY_BLOCKED' ? 422 : 502;
      return fail(error.message, status);
    }
    console.error('[render-mockup]', error instanceof Error ? error.message : error);
    return fail('Unable to render the product mockup. Please try again.', 502);
  }
}
