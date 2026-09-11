/**
 * Shared, isomorphic pendant geometry — the one place both the live canvas
 * preview (components/PendantPreview.tsx) and the server-side laser export
 * (lib/laser-export.ts) get their shape math from.
 *
 * This module has no DOM or Node dependency (same discipline as
 * lib/svg-path-flatten.ts) specifically so it can be imported by both
 * without either side re-deriving the other's formulas by hand. Before this
 * file existed, the cover-fit placement formula lived twice — once inlined
 * in `paintPendant`, once in `laser-export.ts`'s `computeArtworkTransform` —
 * kept in sync only by a comment asking whoever changed one to change the
 * other. `coverFit` below is now the only copy.
 *
 * It also carries the Edge Cut geometry model: a traced silhouette
 * (`SilhouetteContour`, produced once by lib/edge-cut-contour.ts) is just a
 * set of points in the sketch image's own local space, and `transformPoints`
 * applies the *exact* same rotate+scale+translate `coverFit` implies to
 * those points — so a traced silhouette boundary always tracks the artwork
 * in lockstep as the customer zooms, pans or rotates it, on both the canvas
 * and in the exported SVG/DXF, with nothing computed twice.
 */

import { PENDANT_SHAPES, type PendantTransform, type ShapeId } from './pendant-shapes';

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A traced silhouette in a local space whose frame is `imageWidth x
 * imageHeight` with `(0,0)` at the frame's centre — the convention
 * `drawImage(img, -w/2, -h/2)` already uses to draw the sketch itself.
 *
 * CONTRACT: the frame must mean "tight around the subject", because
 * `transformPoints` cover-fits it into the engraving area with the very same
 * maths the renderers use to place the master sketch, and the master sketch
 * is trimmed tight to its ink. `extractSilhouetteContour` (lib/edge-cut-
 * contour.ts) satisfies this trivially — its frame *is* the sketch.
 * `extractPhotoSilhouette` (lib/photo-silhouette.ts) traces the raw photo,
 * whose full frame has margins the sketch doesn't, so it returns the
 * subject's bounding box as the frame instead. Never recomputed on
 * shape/design switches or transform changes.
 */
export interface SilhouetteContour {
  points: Point[];
  imageWidth: number;
  imageHeight: number;
}

export type DesignType = 'standard' | 'edge-cut';
/**
 * 'free'  — the traced silhouette itself is the pendant's outer boundary.
 * 'heart' — the heart stays the outer boundary; the silhouette clips the
 *           artwork inside it instead.
 * 'bust'  — like 'free', but the silhouette is truncated below the
 *           shoulders into a rounded-rectangle base (a bust/plaque mount).
 * 'band'  — like 'free', but offset outward by a visibly larger margin, for
 *           a thicker border band around the subject.
 * All four consume whatever `contour` they're given the same way — 'bust'
 * and 'band' differ only in *which* contour was computed for them (see
 * lib/photo-silhouette.ts's `PhotoSilhouetteStyle`), not in how
 * `resolvePendantGeometry` treats the result.
 */
export type EdgeCutStyle = 'free' | 'heart' | 'bust' | 'band';

export const DEFAULT_DESIGN_TYPE: DesignType = 'standard';
export const DEFAULT_EDGE_CUT_STYLE: EdgeCutStyle = 'free';

const EDGE_CUT_STYLES: readonly EdgeCutStyle[] = ['free', 'heart', 'bust', 'band'];

export function isDesignType(value: string): value is DesignType {
  return value === 'standard' || value === 'edge-cut';
}

export function isEdgeCutStyle(value: string): value is EdgeCutStyle {
  return (EDGE_CUT_STYLES as readonly string[]).includes(value);
}

/**
 * "Cover" fit: scale `imageWidth x imageHeight` so it fully covers `area`
 * (the smaller of the two possible fits, so the image overflows rather than
 * letterboxes), then offset by the customer's own pan. The shape clip is
 * what's expected to crop the resulting overflow — this function only ever
 * decides *how big and where*, never *what gets cut off*.
 */
export function coverFit(
  imageWidth: number,
  imageHeight: number,
  area: Rect,
  transform: PendantTransform,
): { cx: number; cy: number; scale: number } {
  const imageAspect = imageWidth / imageHeight;
  const boxAspect = area.width / area.height;
  const coverScale = imageAspect > boxAspect ? area.height / imageHeight : area.width / imageWidth;
  return {
    cx: area.x + area.width / 2 + transform.x,
    cy: area.y + area.height / 2 + transform.y,
    scale: coverScale * transform.zoom,
  };
}

/**
 * Applies the same rotate+scale+translate `coverFit` implies to arbitrary
 * local points instead of an image. Rotation is applied before the (uniform)
 * scale below, but since scaling is isotropic the two commute — this matches
 * the canvas's own translate/rotate/scale stack exactly regardless of which
 * order it's read in.
 */
export function transformPoints(
  points: Point[],
  imageWidth: number,
  imageHeight: number,
  area: Rect,
  transform: PendantTransform,
): Point[] {
  const { cx, cy, scale } = coverFit(imageWidth, imageHeight, area, transform);
  const theta = (transform.rotation * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return points.map((p) => {
    const rx = p.x * cos - p.y * sin;
    const ry = p.x * sin + p.y * cos;
    return { x: cx + rx * scale, y: cy + ry * scale };
  });
}

/** A closed SVG path `d` string through `points`, using straight segments. */
export function pointsToPath(points: Point[]): string {
  if (points.length === 0) return '';
  const [first, ...rest] = points;
  const segments = rest.map((p) => `L${round(p.x)} ${round(p.y)}`).join(' ');
  return `M${round(first.x)} ${round(first.y)} ${segments} Z`;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * The region other shapes' own content occupies in the shared 100 x 116
 * viewBox (see lib/pendant-shapes.ts) — the top ~21 units are left clear for
 * the bail. Free Edge Cut has no catalogue shape to borrow a box from, so it
 * uses this as its own default cover-fit target, which is what keeps a
 * free-edge pendant's default size and bail clearance consistent with every
 * other shape.
 */
export const EDGE_CUT_AREA: Rect = { x: 9, y: 21, width: 82, height: 90 };

/** Shown in place of a traced silhouette while one hasn't been computed yet (or failed to). */
function placeholderPath(area: Rect): string {
  const cx = area.x + area.width / 2;
  const cy = area.y + area.height / 2;
  const r = Math.min(area.width, area.height) / 2;
  return `M${cx - r} ${cy} A${r} ${r} 0 1 0 ${cx + r} ${cy} A${r} ${r} 0 1 0 ${cx - r} ${cy} Z`;
}

export interface PendantGeometry {
  /** The metal boundary: fill/sheen/rim/bail are all drawn against this path. */
  outerPath: string;
  /** Cover-fit target box the artwork is placed into. */
  engravingArea: Rect;
  /**
   * An *additional* clip the artwork (not the metal boundary) must also
   * satisfy, already transformed into the same space as `outerPath`. Only
   * ever set for Edge Cut inside Heart, where the metal stays heart-shaped
   * but the engraving is further clipped to the traced silhouette.
   */
  artworkClipPath?: string;
  /**
   * Whether `paintPendant` should stroke a separate decorative rim along
   * `outerPath`. True for a catalogue shape (Standard, and Edge Cut inside
   * Heart — both real, closed jewellery outlines where a rim reads as the
   * plate's edge). False for a traced silhouette (Free Edge Cut / Bust with
   * Base / Silhouette Band): on an organic, irregular contour that same
   * stroke doesn't read as a metal edge, it reads as exactly the artificial
   * outline/halo/border the customer explicitly does not want — the traced
   * boundary itself must be the cutting boundary, with nothing drawn around
   * it. See components/PendantPreview.tsx's `paintPendant`.
   */
  hasDecorativeRim: boolean;
  /**
   * True for every Edge Cut style (free/heart/bust/band), false for
   * Standard. `paintPendant` uses this to switch its entire rendering path:
   * Standard renders a dimensional metal plate (gradient fill, sheen,
   * emboss, bail with its own highlight); Edge Cut renders flat,
   * material-tinted line art only — no plate, no gradient, no shadow, no
   * dimensional bail — matching a customer-supplied reference of the
   * expected result (a clean cutout of the artwork itself, not a rendered
   * piece of jewellery). "Choose Material" for Edge Cut recolors the ink
   * itself rather than rendering metal underneath it.
   */
  isFlatArtwork: boolean;
  /**
   * Flat-artwork styles whose boundary deliberately extends *beyond* the
   * ink — Bust with Base (a solid base below the shoulders) and Silhouette
   * Band (a solid border around the subject). Clipping the artwork alone
   * would render those regions as nothing at all, so the preview couldn't
   * tell them apart from Free Edge Cut; `paintFlatArtwork` fills the
   * boundary with a light flat metal tone for these two so the base/band
   * is visible as the piece of metal it is. False for Free and Heart, which
   * stay artwork-only.
   */
  fillsBoundary: boolean;
  label: string;
}

export interface ResolvePendantGeometryInput {
  designType: DesignType;
  shape: ShapeId;
  edgeCutStyle: EdgeCutStyle;
  /** The shape's or category's own engraving box — unused for Free Edge Cut, which supplies its own. */
  engravingArea: Rect;
  contour: SilhouetteContour | null;
  transform: PendantTransform;
}

/**
 * The single place that turns "what the customer picked" into "what to draw
 * and clip against". Both `paintPendant` (client canvas) and
 * `renderTransformedArtwork` (server raster/SVG export) call this and then
 * differ only in *how* they rasterize the same paths — never in what the
 * paths are.
 */
export function resolvePendantGeometry(input: ResolvePendantGeometryInput): PendantGeometry {
  const { designType, shape, edgeCutStyle, engravingArea, contour, transform } = input;

  if (designType === 'standard') {
    const shapeDef = PENDANT_SHAPES[shape];
    return {
      outerPath: shapeDef.path,
      engravingArea,
      hasDecorativeRim: true,
      isFlatArtwork: false,
      fillsBoundary: false,
      label: shapeDef.label,
    };
  }

  if (edgeCutStyle === 'heart') {
    const heart = PENDANT_SHAPES.heart;
    const artworkClipPath = contour
      ? pointsToPath(
          transformPoints(contour.points, contour.imageWidth, contour.imageHeight, engravingArea, transform),
        )
      : undefined;
    return {
      outerPath: heart.path,
      engravingArea,
      artworkClipPath,
      hasDecorativeRim: true,
      isFlatArtwork: true,
      fillsBoundary: false,
      label: 'Edge Cut Heart',
    };
  }

  // 'free' | 'bust' | 'band': the traced silhouette itself is the outer
  // boundary, so it needs no separate artwork clip — the metal edge already
  // is the clip. The three differ only in which `contour` the caller
  // supplies (see lib/photo-silhouette.ts's `PhotoSilhouetteStyle`).
  const outerPath = contour
    ? pointsToPath(
        transformPoints(contour.points, contour.imageWidth, contour.imageHeight, EDGE_CUT_AREA, transform),
      )
    : placeholderPath(EDGE_CUT_AREA);
  const label = edgeCutStyle === 'bust' ? 'Bust with Base' : edgeCutStyle === 'band' ? 'Silhouette Band' : 'Edge Cut';
  return {
    outerPath,
    engravingArea: EDGE_CUT_AREA,
    hasDecorativeRim: false,
    isFlatArtwork: true,
    fillsBoundary: edgeCutStyle !== 'free',
    label,
  };
}
