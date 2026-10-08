/**
 * POST /api/export-laser
 *
 * Turns the already-generated masterSketch into manufacturing files: a DXF
 * and an SVG, plus a transparent PNG — see the big comment in
 * lib/laser-export.ts for the full pipeline. No AI call happens here, and
 * the artwork is not altered: the files are the cut layout as vectors.
 * Vectorizing (potrace) and rasterizing (sharp) both need Node.
 *
 * For Silhouette Cut designs, the traced outline (`contour`) is computed
 * once, client-side, by lib/edge-cut-contour.ts and sent here as plain data
 * rather than recomputed — recomputing it server-side would mean two
 * independent implementations of the same geometry, exactly the drift this
 * app has already been burned by once (see lib/pendant-geometry.ts).
 */

import { after } from 'next/server';
import { archive, orderFolder, zip } from '@/lib/archive';
import { parseDesignRequest } from '@/lib/design-request';
import { trackEvent } from '@/lib/tracking';
import { buildLaserExportAssets } from '@/lib/laser-export';

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
    return fail('Something went wrong. Please try again.', 400);
  }

  const parsed = parseDesignRequest(body);
  if (!parsed.ok) return fail(parsed.error, 400);

  const widthMmRaw = (body as Record<string, unknown>).widthMm;
  const widthMm = typeof widthMmRaw === 'number' && widthMmRaw > 0 && widthMmRaw <= 200 ? widthMmRaw : undefined;

  try {
    const result = await buildLaserExportAssets({ ...parsed.value, widthMm });
    // Kept in the cloud with the rest of the order, zipped (lib/archive.ts),
    // once the files have gone back. The download used to wait on this, and
    // a slow upload held ten megabytes of finished files for minutes.
    const folder = orderFolder(parsed.value.sketch);
    after(async () => {
      const file = await archive(
        folder,
        'production-files.zip',
        zip([
          { name: 'pendant.dxf', data: Buffer.from(result.dxf, 'utf8') },
          { name: 'pendant.svg', data: Buffer.from(result.svg, 'utf8') },
          { name: 'engraving.png', data: Buffer.from(result.pngDataUrl.slice(result.pngDataUrl.indexOf(',') + 1), 'base64') },
        ]),
        'application/zip',
        { latestOnly: true },
      );
      await trackEvent({ kind: 'production_files', folder, detail: parsed.value.designType, costUsd: 0, file });
    });
    return Response.json({ success: true, ...result });
  } catch (error) {
    console.error('[export-laser]', error instanceof Error ? error.message : error);
    return fail('We couldn\'t prepare the files. Please try again.', 502);
  }
}
