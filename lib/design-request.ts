/**
 * The one description of "the design the customer is looking at" that the
 * browser sends to the server — shared by `/api/export-laser` (SVG/DXF/3DM)
 * and `/api/render-mockup` (AI product photo), so both validate the same
 * fields the same way and neither can drift from the other.
 *
 * Everything here is validated as untrusted input: the browser is the only
 * intended client, but a route handler can be called by anything.
 */

import { isMaterialId, isRimColorId, type MaterialId, type RimColorId } from './materials';
import { isCategoryId, type CategoryId } from './pendant-categories';
import { isDesignType, type DesignType, type Rect, type SilhouetteContour } from './pendant-geometry';
import { isShapeId, type PendantTransform, type ShapeId } from './pendant-shapes';

const MAX_CONTOUR_POINTS = 2000;
/** Upper bound on the master sketch data URL — a generous multiple of what lib/image-processing.ts produces. */
const MAX_SKETCH_CHARS = 12 * 1024 * 1024;

export interface DesignRequest {
  /** The masterSketch data URL — the one and only AI-generated artwork, unchanged. */
  sketch: string;
  shape: ShapeId;
  material: MaterialId;
  transform: PendantTransform;
  engravingArea: Rect;
  designType: DesignType;
  /** Required when `designType` is 'edge-cut'; `null` otherwise. */
  contour: SilhouetteContour | null;
  rimColor: RimColorId;
  category: CategoryId | null;
}

export type ParseResult = { ok: true; value: DesignRequest } | { ok: false; error: string };

function isPendantTransform(value: unknown): value is PendantTransform {
  if (!value || typeof value !== 'object') return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.zoom === 'number' &&
    t.zoom > 0 &&
    Number.isFinite(t.x) &&
    Number.isFinite(t.y) &&
    Number.isFinite(t.rotation)
  );
}

function isRect(value: unknown): value is Rect {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    Number.isFinite(r.x) &&
    Number.isFinite(r.y) &&
    typeof r.width === 'number' &&
    r.width > 0 &&
    typeof r.height === 'number' &&
    r.height > 0
  );
}

const MAX_HOLES = 4;

function isPointList(value: unknown): value is { x: number; y: number }[] {
  return (
    Array.isArray(value) &&
    value.length >= 3 &&
    value.length <= MAX_CONTOUR_POINTS &&
    value.every(
      (p) =>
        p &&
        typeof p === 'object' &&
        Number.isFinite((p as Record<string, unknown>).x) &&
        Number.isFinite((p as Record<string, unknown>).y),
    )
  );
}

function isSilhouetteContour(value: unknown): value is SilhouetteContour {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  if (typeof c.imageWidth !== 'number' || c.imageWidth <= 0) return false;
  if (typeof c.imageHeight !== 'number' || c.imageHeight <= 0) return false;
  if (!isPointList(c.points)) return false;
  const isCurveList = (v: unknown) => Array.isArray(v) && v.length <= MAX_HOLES && v.every(isPointList);
  return isCurveList(c.rings) && isCurveList(c.holes);
}

export function parseDesignRequest(body: unknown): ParseResult {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Unable to read the request.' };
  const b = body as Record<string, unknown>;

  if (typeof b.sketch !== 'string' || !b.sketch.startsWith('data:image/') || b.sketch.length > MAX_SKETCH_CHARS) {
    return { ok: false, error: 'No design to work from yet — generate a sketch first.' };
  }
  if (typeof b.shape !== 'string' || !isShapeId(b.shape)) return { ok: false, error: 'Unknown pendant shape.' };
  if (typeof b.material !== 'string' || !isMaterialId(b.material)) return { ok: false, error: 'Unknown material.' };
  if (!isPendantTransform(b.transform)) return { ok: false, error: 'Invalid adjustment values.' };
  if (!isRect(b.engravingArea)) return { ok: false, error: 'Invalid engraving area.' };

  const designType = typeof b.designType === 'string' && isDesignType(b.designType) ? b.designType : 'standard';
  const rimColor = typeof b.rimColor === 'string' && isRimColorId(b.rimColor) ? b.rimColor : 'none';
  const category = typeof b.category === 'string' && isCategoryId(b.category) ? b.category : null;

  let contour: SilhouetteContour | null = null;
  if (designType === 'edge-cut') {
    if (!isSilhouetteContour(b.contour)) {
      return { ok: false, error: 'The silhouette outline is missing — try re-selecting Silhouette Cut and trying again.' };
    }
    contour = b.contour;
  }

  return {
    ok: true,
    value: {
      sketch: b.sketch,
      shape: b.shape,
      material: b.material,
      transform: b.transform,
      engravingArea: b.engravingArea,
      designType,
      contour,
      rimColor,
      category,
    },
  };
}
