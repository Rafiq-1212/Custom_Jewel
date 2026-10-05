/**
 * POST /api/export-laser
 *
 * Turns the already-generated masterSketch into manufacturing files: SVG,
 * DXF and Rhino 3DM, plus a transparent PNG — see the big comment in
 * lib/laser-export.ts for the full pipeline. Vectorizing (potrace),
 * rasterizing (sharp) and writing .3dm (rhino3dm WASM) all need Node.
 *
 * The one thing done to the artwork here, and only here, is taking the fine
 * shading off the faces (lib/face-clean.ts): it engraves as dark patches.
 * The sketch on screen and the product photo keep it. That step looks at
 * the drawing with a text model to find the faces; no picture is redrawn.
 *
 * For Silhouette Cut designs, the traced outline (`contour`) is computed
 * once, client-side, by lib/edge-cut-contour.ts and sent here as plain data
 * rather than recomputed — recomputing it server-side would mean two
 * independent implementations of the same geometry, exactly the drift this
 * app has already been burned by once (see lib/pendant-geometry.ts).
 */

import { archive, orderFolder, zip } from '@/lib/archive';
import { costSoFar, withCostLog } from '@/lib/cost';
import { parseDesignRequest } from '@/lib/design-request';
import { cleanFaceShading } from '@/lib/face-clean';
import { trackEvent } from '@/lib/tracking';
import { buildLaserExportAssets } from '@/lib/laser-export';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function fail(message: string, status: number): Response {
  return Response.json({ success: false, error: message }, { status });
}

/** The sketch (a data URL) with the face shading removed; the sketch itself if that fails. */
async function withoutFaceShading(sketch: string): Promise<string> {
  try {
    const cleaned = await cleanFaceShading(Buffer.from(sketch.slice(sketch.indexOf(',') + 1), 'base64'));
    return `data:image/png;base64,${cleaned.toString('base64')}`;
  } catch (error) {
    console.error('[export-laser] face shading left as drawn:', error instanceof Error ? error.message : error);
    return sketch;
  }
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

  const widthMmRaw = (body as Record<string, unknown>).widthMm;
  const widthMm = typeof widthMmRaw === 'number' && widthMmRaw > 0 && widthMmRaw <= 200 ? widthMmRaw : undefined;

  try {
    let spent = 0;
    const sketch = await withCostLog('production files', async () => {
      const cleaned = await withoutFaceShading(parsed.value.sketch);
      spent = costSoFar();
      return cleaned;
    });
    const result = await buildLaserExportAssets({ ...parsed.value, sketch, widthMm });
    // Kept in the cloud with the rest of the order, zipped (lib/archive.ts).
    const folder = orderFolder(parsed.value.sketch);
    const file = await archive(
      folder,
      'production-files.zip',
      zip([
        { name: 'pendant.svg', data: Buffer.from(result.svg, 'utf8') },
        { name: 'pendant.dxf', data: Buffer.from(result.dxf, 'utf8') },
        { name: 'pendant.3dm', data: Buffer.from(result.threeDmBase64, 'base64') },
        { name: 'engraving.png', data: Buffer.from(result.pngDataUrl.slice(result.pngDataUrl.indexOf(',') + 1), 'base64') },
      ]),
      'application/zip',
      { latestOnly: true },
    );
    await trackEvent({ kind: 'production_files', folder, detail: parsed.value.designType, costUsd: spent, file });
    return Response.json({ success: true, ...result });
  } catch (error) {
    console.error('[export-laser]', error instanceof Error ? error.message : error);
    return fail('We couldn\'t prepare the files. Please try again.', 502);
  }
}
