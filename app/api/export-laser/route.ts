/**
 * POST /api/export-laser
 *
 * Turns the already-generated masterSketch into laser-cutting-ready assets:
 * SVG, DXF, and a transparent PNG. No AI call happens here — see the big
 * comment in lib/laser-export.ts for the full pipeline. This route exists
 * only because vectorizing (potrace) and rasterizing (sharp) both need
 * Node, not because anything here talks to Gemini.
 *
 * For Edge Cut designs, the traced silhouette (`contour`) is computed once,
 * client-side, by lib/edge-cut-contour.ts and sent here as plain data rather
 * than recomputed — recomputing it server-side would mean two independent
 * implementations of the same geometry, exactly the drift this app has
 * already been burned by once (see lib/pendant-geometry.ts's doc comment).
 */

import { buildLaserExportAssets } from '@/lib/laser-export';
import { isMaterialId } from '@/lib/materials';
import { isDesignType, isEdgeCutStyle, type Rect, type SilhouetteContour } from '@/lib/pendant-geometry';
import { isShapeId, type PendantTransform } from '@/lib/pendant-shapes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const MAX_CONTOUR_POINTS = 500;

interface ExportRequestBody {
  sketch?: unknown;
  shape?: unknown;
  material?: unknown;
  transform?: unknown;
  engravingArea?: unknown;
  designType?: unknown;
  edgeCutStyle?: unknown;
  contour?: unknown;
  widthMm?: unknown;
}

function fail(message: string, status: number): Response {
  return Response.json({ success: false, error: message }, { status });
}

function isPendantTransform(value: unknown): value is PendantTransform {
  if (!value || typeof value !== 'object') return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.zoom === 'number' &&
    typeof t.x === 'number' &&
    typeof t.y === 'number' &&
    typeof t.rotation === 'number'
  );
}

function isRect(value: unknown): value is Rect {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.x === 'number' &&
    typeof r.y === 'number' &&
    typeof r.width === 'number' &&
    r.width > 0 &&
    typeof r.height === 'number' &&
    r.height > 0
  );
}

function isSilhouetteContour(value: unknown): value is SilhouetteContour {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  if (typeof c.imageWidth !== 'number' || c.imageWidth <= 0) return false;
  if (typeof c.imageHeight !== 'number' || c.imageHeight <= 0) return false;
  if (!Array.isArray(c.points) || c.points.length < 3 || c.points.length > MAX_CONTOUR_POINTS) return false;
  return c.points.every(
    (p) =>
      p &&
      typeof p === 'object' &&
      Number.isFinite((p as Record<string, unknown>).x) &&
      Number.isFinite((p as Record<string, unknown>).y),
  );
}

export async function POST(request: Request): Promise<Response> {
  let body: ExportRequestBody;
  try {
    body = (await request.json()) as ExportRequestBody;
  } catch {
    return fail('Unable to read the request.', 400);
  }

  if (typeof body.sketch !== 'string' || !body.sketch.startsWith('data:image/')) {
    return fail('No design to export yet — generate a sketch first.', 400);
  }
  if (typeof body.shape !== 'string' || !isShapeId(body.shape)) {
    return fail('Unknown pendant shape.', 400);
  }
  if (typeof body.material !== 'string' || !isMaterialId(body.material)) {
    return fail('Unknown material.', 400);
  }
  if (!isPendantTransform(body.transform)) {
    return fail('Invalid adjustment values.', 400);
  }
  if (!isRect(body.engravingArea)) {
    return fail('Invalid engraving area.', 400);
  }
  const designType = typeof body.designType === 'string' && isDesignType(body.designType) ? body.designType : 'standard';
  const edgeCutStyle =
    typeof body.edgeCutStyle === 'string' && isEdgeCutStyle(body.edgeCutStyle) ? body.edgeCutStyle : 'free';

  let contour: SilhouetteContour | null = null;
  if (designType === 'edge-cut') {
    if (!isSilhouetteContour(body.contour)) {
      return fail('Missing or invalid edge-cut silhouette — try re-selecting Edge Cut and exporting again.', 400);
    }
    contour = body.contour;
  }

  const widthMm =
    typeof body.widthMm === 'number' && body.widthMm > 0 && body.widthMm <= 200 ? body.widthMm : undefined;

  try {
    const result = await buildLaserExportAssets({
      sketch: body.sketch,
      shape: body.shape,
      material: body.material,
      transform: body.transform,
      engravingArea: body.engravingArea,
      designType,
      edgeCutStyle,
      contour,
      widthMm,
    });
    return Response.json({ success: true, ...result });
  } catch (error) {
    console.error('[export-laser]', error instanceof Error ? error.message : error);
    return fail('Unable to prepare the laser-cutting files. Please try again.', 502);
  }
}
