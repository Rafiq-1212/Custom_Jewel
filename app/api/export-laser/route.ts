/**
 * POST /api/export-laser
 *
 * Turns the already-generated masterSketch into manufacturing files: SVG,
 * DXF and Rhino 3DM, plus a transparent PNG. No AI call happens here — see
 * the big comment in lib/laser-export.ts for the full pipeline. This route
 * exists only because vectorizing (potrace), rasterizing (sharp) and writing
 * .3dm (rhino3dm WASM) all need Node, not because anything here talks to
 * Gemini.
 *
 * For Silhouette Cut designs, the traced outline (`contour`) is computed
 * once, client-side, by lib/edge-cut-contour.ts and sent here as plain data
 * rather than recomputed — recomputing it server-side would mean two
 * independent implementations of the same geometry, exactly the drift this
 * app has already been burned by once (see lib/pendant-geometry.ts).
 */

import { parseDesignRequest } from '@/lib/design-request';
import { buildLaserExportAssets } from '@/lib/laser-export';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

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

  const widthMmRaw = (body as Record<string, unknown>).widthMm;
  const widthMm = typeof widthMmRaw === 'number' && widthMmRaw > 0 && widthMmRaw <= 200 ? widthMmRaw : undefined;

  try {
    const result = await buildLaserExportAssets({ ...parsed.value, widthMm });
    return Response.json({ success: true, ...result });
  } catch (error) {
    console.error('[export-laser]', error instanceof Error ? error.message : error);
    return fail('Unable to prepare the manufacturing files. Please try again.', 502);
  }
}
