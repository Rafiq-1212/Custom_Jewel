/**
 * Pendant shape registry — pure geometry, no rendering or AI logic here.
 *
 * The shapes are the photo-pendant plates in the True Tribute catalogue
 * (Round, Oval, Heart, Bar, Tag, Octagonal). Every shape is one SVG path
 * string in a shared 100 x 116 viewBox — each path leaves roughly 21 units
 * of headroom above it (bail clearance, kept so every shape and every
 * category's engraving box share one coordinate space). Adding a shape later
 * is exactly one entry in `PENDANT_SHAPES` — the shape picker, the canvas
 * renderer, the exports and the shape's own icon all derive from that path.
 */

export const PENDANT_VIEWBOX = { width: 100, height: 116 } as const;

export type ShapeId = 'round' | 'oval' | 'heart' | 'bar' | 'tag' | 'octagon';

export interface PendantShape {
  id: ShapeId;
  label: string;
  /** SVG path data (the `d` attribute) in the shared 100 x 116 viewBox. */
  path: string;
  /**
   * Where the sketch is composited, in the same viewBox units. Generic
   * (centred, inset from the shape's bounding box) rather than hand-tuned per
   * shape — good enough for an automatic fit, and the zoom/position/rotation
   * controls exist precisely to let the customer correct the rest.
   */
  engravingArea: { x: number; y: number; width: number; height: number };
  /**
   * Whether the catalogue sells this plate with a coloured enamel rim
   * ("Heart with Color", "Round with Color"). Only affects the preview and
   * the AI mockup — the cut/engrave files are the same plate either way.
   */
  supportsRim: boolean;
}

function roundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  return (
    `M${x + r} ${y} H${x + w - r} A${r} ${r} 0 0 1 ${x + w} ${y + r} ` +
    `V${y + h - r} A${r} ${r} 0 0 1 ${x + w - r} ${y + h} ` +
    `H${x + r} A${r} ${r} 0 0 1 ${x} ${y + h - r} ` +
    `V${y + r} A${r} ${r} 0 0 1 ${x + r} ${y} Z`
  );
}

/** A full circle/ellipse expressed as two arcs, since SVG has no native ellipse path command. */
function ellipsePath(cx: number, cy: number, rx: number, ry: number): string {
  return (
    `M${cx - rx} ${cy} A${rx} ${ry} 0 1 0 ${cx + rx} ${cy} ` +
    `A${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`
  );
}

/** Regular octagon with a flat top and bottom (vertices at 22.5° + k·45°). */
function octagonPath(cx: number, cy: number, r: number): string {
  const points: string[] = [];
  for (let k = 0; k < 8; k++) {
    const theta = ((22.5 + 45 * k) * Math.PI) / 180;
    points.push(`${(cx + r * Math.cos(theta)).toFixed(2)} ${(cy + r * Math.sin(theta)).toFixed(2)}`);
  }
  return `M${points.join(' L')} Z`;
}

export const PENDANT_SHAPES: Record<ShapeId, PendantShape> = {
  round: {
    id: 'round',
    label: 'Round',
    path: ellipsePath(50, 66, 45, 45),
    engravingArea: { x: 17, y: 33, width: 66, height: 66 },
    supportsRim: true,
  },
  oval: {
    id: 'oval',
    label: 'Oval',
    path: ellipsePath(50, 66, 32, 44),
    engravingArea: { x: 24, y: 34, width: 52, height: 64 },
    supportsRim: false,
  },
  heart: {
    id: 'heart',
    label: 'Heart',
    path: 'M50 111 C32 96 9 80 9 58 C9 41 22 31 35 31 C43 31 48 36 50 41 C52 36 57 31 65 31 C78 31 91 41 91 58 C91 80 68 96 50 111 Z',
    engravingArea: { x: 27, y: 45, width: 46, height: 46 },
    supportsRim: true,
  },
  bar: {
    id: 'bar',
    label: 'Bar',
    path: roundedRectPath(32, 22, 36, 88, 5),
    engravingArea: { x: 36, y: 28, width: 28, height: 76 },
    supportsRim: false,
  },
  tag: {
    id: 'tag',
    label: 'Tag',
    path: roundedRectPath(25, 24, 50, 84, 16),
    engravingArea: { x: 31, y: 32, width: 38, height: 68 },
    supportsRim: false,
  },
  octagon: {
    id: 'octagon',
    label: 'Octagonal',
    path: octagonPath(50, 66, 45),
    engravingArea: { x: 20, y: 36, width: 60, height: 60 },
    supportsRim: false,
  },
};

export const PENDANT_SHAPE_LIST: PendantShape[] = Object.values(PENDANT_SHAPES);

export const DEFAULT_SHAPE_ID: ShapeId = 'heart';

export function isShapeId(value: string): value is ShapeId {
  return value in PENDANT_SHAPES;
}

/* -------------------------------------------------------------------------- */
/* Image transform — zoom / position / rotation. Frontend-only; never touches */
/* the AI. Changing this can never trigger a new generation.                  */
/* -------------------------------------------------------------------------- */

export interface PendantTransform {
  zoom: number;
  x: number;
  y: number;
  rotation: number;
}

export const DEFAULT_TRANSFORM: PendantTransform = { zoom: 1, x: 0, y: 0, rotation: 0 };
