/**
 * The product photograph, in the two steps a batch job forces it into.
 *
 * Turns the current design into a photorealistic product photograph via
 * Gemini — see lib/mockup.ts for why this second AI call exists and what it
 * is (and isn't) allowed to change. Runs only when the operator explicitly
 * asks for a mockup of a specific metal; the live preview never calls it.
 *
 *   POST  the design           -> { job }       submits it at half price
 *   GET   ?job=...&material=   -> { state } or  { dataUrl } once it is done
 *
 * The design body is the same as /api/export-laser (lib/design-request.ts),
 * so the mockup and the manufacturing files always describe the same pendant.
 */

import { withCostLog } from '@/lib/cost';
import { parseDesignRequest } from '@/lib/design-request';
import { GeminiGenerationError } from '@/lib/gemini';
import { readJobState } from '@/lib/gemini-batch';
import { collectPendantMockup, startPendantMockup } from '@/lib/mockup';
import { isMaterialId } from '@/lib/materials';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** A job name as the API returns it. */
const JOB_NAME = /^batches\/[A-Za-z0-9_-]{1,128}$/;

function fail(message: string, status: number): Response {
  return Response.json({ success: false, error: message }, { status });
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail('Something went wrong. Please try again.', 400);
  }

  const parsed = parseDesignRequest(body);
  if (!parsed.ok) return fail(parsed.error, 400);

  try {
    return Response.json({ success: true, job: await startPendantMockup(parsed.value) });
  } catch (error) {
    if (error instanceof GeminiGenerationError) {
      // Technical detail stays in the server log; the browser gets the one
      // customer-facing sentence for this code, same as /api/generate-image.
      console.error(`[render-mockup] ${error.code}: ${error.detail ?? error.message}`);
      const status = error.code === 'RATE_LIMITED' ? 429 : error.code === 'SAFETY_BLOCKED' ? 422 : 502;
      return fail(error.message, status);
    }
    console.error('[render-mockup]', error instanceof Error ? error.message : error);
    return fail('We couldn\'t make the product photo. Please try again.', 502);
  }
}

/** GET /api/render-mockup?job=batches/...&material=gold — the state, or the picture. */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const name = params.get('job');
  const material = params.get('material');
  if (!name || !JOB_NAME.test(name) || !material || !isMaterialId(material)) {
    return fail('That product photo does not exist any more. Please make it again.', 400);
  }
  try {
    const state = await readJobState(name);
    if (state !== 'done') return Response.json({ success: true, state });
    const result = await withCostLog(`mockup ${material}`, () => collectPendantMockup(name, material));
    return Response.json({ success: true, state, ...result });
  } catch (error) {
    if (error instanceof GeminiGenerationError) {
      console.error(`[render-mockup] ${error.code}: ${error.detail ?? error.message}`);
      const status = error.code === 'RATE_LIMITED' ? 429 : error.code === 'SAFETY_BLOCKED' ? 422 : 502;
      return fail(error.message, status);
    }
    console.error('[render-mockup]', error instanceof Error ? error.message : error);
    return fail('We couldn\'t make the product photo. Please try again.', 502);
  }
}
