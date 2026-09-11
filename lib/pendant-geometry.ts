/**
 * Shared, isomorphic pendant geometry — the one place the live canvas
 * preview (components/PendantPreview.tsx), the server-side laser export
 * (lib/laser-export.ts) and the AI mockup composite (lib/mockup.ts) all get
 * their shape math from.
 *
 * This module has no DOM or Node dependency (same discipline as
 * lib/svg-path-flatten.ts) specifically so it can be imported by all of them
 * without any side re-deriving another's formulas by hand. `fitArtwork` below
 * is the only copy of the artwork placement formula.
 *
 * It also carries the Silhouette Cut geometry model: a traced silhouette
 * (`SilhouetteContour`, produced once by lib/edge-cut-contour.ts) is just a
 * set of points in the sketch image's own local space, and `transformPoints`
 * applies the *exact* same rotate+scale+translate `fitArtwork` implies to
 * those points — so the traced cut boundary always tracks the artwork in
 * lockstep as the customer zooms, pans or rotates it, on the canvas, in the
 * mockup and in the exported SVG/DXF/3DM, with nothing computed twice.
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
 * contour.ts) satisfies this trivially — it traces the sketch itself, so its
 * frame *is* the sketch. Never recomputed on shape/design switches or
 * transform changes.
 */
export interface SilhouetteContour {
  /** The outer cut boundary — the artwork's outline offset by the cut margin, with the hanging ring merged in. */
  points: Point[];
  /**
   * Closed inner contours in the same local space that are cut OUT of the
   * plate — in practice the round hole of the hanging ring. Rendered with an
   * even-odd fill rule everywhere (canvas, SVG, sharp mask, DXF/3DM as their
   * own closed polylines on the CUT layer).
   */
  holes: Point[][];
  imageWidth: number;
  imageHeight: number;
}

/**
 * 'standard'  — a catalogue plate (Round, Oval, Heart, Bar, Tag, Octagonal)
 *               with the artwork engraved on it.
 * 'edge-cut'  — the catalogue's Face / Half Size / Couple / Family / Pet
 *               pendants: the metal is cut along the artwork's own outline.
 */
export type DesignType = 'standard' | 'edge-cut';

/** Silhouette Cut is the catalogue's primary photo pendant (Face / Couple / Family / ...), so it's the default. */
export const DEFAULT_DESIGN_TYPE: DesignType = 'edge-cut';

export function isDesignType(value: string): value is DesignType {
  return value === 'standard' || value === 'edge-cut';
}

/**
 * 'cover'   — scale so the image fully covers `area` (the larger of the two
 *             fits): it overflows rather than letterboxes, and the plate's
 *             clip is what crops the overflow. Right for a Shape Pendant.
 * 'contain' — scale so the image fits entirely inside `area` (the smaller
 *             fit). Right for a Silhouette Cut, where nothing crops the
 *             artwork — the cut follows it — so a wide couple sketch
 *             cover-fit into a tall box would simply become a pendant wider
 *             than the canvas (verified: a DXF spanning -7…32 mm on a 25 mm
 *             canvas).
 */
export type FitMode = 'cover' | 'contain';

/**
 * Where and how big the artwork goes: scale `imageWidth x imageHeight` into
 * `area` per `mode`, then offset by the customer's own pan and zoom. This
 * function only ever decides *how big and where*, never *what gets cut off*.
 */
export function fitArtwork(
  imageWidth: number,
  imageHeight: number,
  area: Rect,
  transform: PendantTransform,
  mode: FitMode,
): { cx: number; cy: number; scale: number } {
  const byHeight = area.height / imageHeight;
  const byWidth = area.width / imageWidth;
  const fitScale = mode === 'cover' ? Math.max(byHeight, byWidth) : Math.min(byHeight, byWidth);
  return {
    cx: area.x + area.width / 2 + transform.x,
    cy: area.y + area.height / 2 + transform.y,
    scale: fitScale * transform.zoom,
  };
}

/** `fitArtwork` for a resolved geometry — the call every renderer makes, so none can pick a different mode. */
export function placeArtwork(
  geometry: PendantGeometry,
  imageWidth: number,
  imageHeight: number,
  transform: PendantTransform,
): { cx: number; cy: number; scale: number } {
  return fitArtwork(imageWidth, imageHeight, geometry.engravingArea, transform, geometry.fitMode);
}

/**
 * Applies the same rotate+scale+translate `fitArtwork` implies to arbitrary
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
  mode: FitMode,
): Point[] {
  const { cx, cy, scale } = fitArtwork(imageWidth, imageHeight, area, transform, mode);
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
 * The region the catalogue shapes occupy in the shared 100 x 116 viewBox
 * (see lib/pendant-shapes.ts) — the top ~21 units are left clear for the
 * bail. A Silhouette Cut has no catalogue shape to borrow a box from, so it
 * uses this as its own cover-fit target, which keeps a silhouette pendant's
 * default size and bail clearance consistent with every other shape.
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
  /**
   * The metal boundary: fill/sheen/rim are all drawn against this path.
   * May contain several subpaths (a Silhouette Cut's outline plus its ring
   * hole) — always fill and clip it with the EVEN-ODD rule so inner
   * subpaths read as holes. Catalogue shapes are a single subpath, for
   * which even-odd and nonzero agree.
   */
  outerPath: string;
  /** Target box the artwork is fit into, per `fitMode`. */
  engravingArea: Rect;
  /** How the artwork is fit into `engravingArea` — see `FitMode`. */
  fitMode: FitMode;
  /**
   * Whether `paintPendant` should stroke a separate decorative rim along
   * `outerPath`. True for a catalogue plate, where a rim reads as the
   * plate's edge. False for a traced silhouette: on an organic contour that
   * same stroke reads as exactly the artificial outline/halo the product
   * doesn't have — the traced boundary itself is the cutting boundary.
   */
  hasDecorativeRim: boolean;
  label: string;
}

export interface ResolvePendantGeometryInput {
  designType: DesignType;
  shape: ShapeId;
  /** The shape's or category's own engraving box — unused for Silhouette Cut, which supplies its own. */
  engravingArea: Rect;
  contour: SilhouetteContour | null;
  transform: PendantTransform;
}

/**
 * The single place that turns "what the customer picked" into "what to draw
 * and clip against". The canvas, the laser export and the mockup composite
 * all call this and then differ only in *how* they rasterize the same paths
 * — never in what the paths are.
 */
export function resolvePendantGeometry(input: ResolvePendantGeometryInput): PendantGeometry {
  const { designType, shape, engravingArea, contour, transform } = input;

  if (designType === 'standard') {
    const shapeDef = PENDANT_SHAPES[shape];
    return {
      outerPath: shapeDef.path,
      engravingArea,
      fitMode: 'cover',
      hasDecorativeRim: true,
      label: shapeDef.label,
    };
  }

  // Silhouette Cut: the traced outline (artwork + cut margin + ring) is the
  // outer boundary, and the ring's hole rides along as a second subpath —
  // both carried through the exact same transform as the artwork.
  let outerPath = placeholderPath(EDGE_CUT_AREA);
  if (contour) {
    const { imageWidth, imageHeight } = contour;
    const place = (points: Point[]) =>
      pointsToPath(transformPoints(points, imageWidth, imageHeight, EDGE_CUT_AREA, transform, 'contain'));
    outerPath = [place(contour.points), ...contour.holes.map(place)].join(' ');
  }
  return {
    outerPath,
    engravingArea: EDGE_CUT_AREA,
    fitMode: 'contain',
    hasDecorativeRim: false,
    label: 'Silhouette Cut',
  };
}
