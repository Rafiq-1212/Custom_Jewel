/**
 * Pendant shape registry — pure geometry, no rendering or AI logic here.
 *
 * Every shape is one SVG path string in a shared 100 x 116 viewBox — each
 * shape's own path leaves roughly 16 units of headroom above it (originally
 * reserved for a bail/loop, since removed; left as-is rather than re-tuning
 * every hand-drawn shape path and every category's engraving-area box around
 * a resized viewBox). Adding a shape later is exactly one entry in
 * `PENDANT_SHAPES` — the shape picker, the canvas renderer, and each shape's
 * icon all derive from this one path, so nothing else in the app needs to
 * change.
 */

export const PENDANT_VIEWBOX = { width: 100, height: 116 } as const;

export type ShapeId = 'heart' | 'diamond' | 'square' | 'circle' | 'oval' | 'rectangle' | 'hexagon';

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

export const PENDANT_SHAPES: Record<ShapeId, PendantShape> = {
  heart: {
    id: 'heart',
    label: 'Heart',
    path: 'M50 111 C32 96 9 80 9 58 C9 41 22 31 35 31 C43 31 48 36 50 41 C52 36 57 31 65 31 C78 31 91 41 91 58 C91 80 68 96 50 111 Z',
    engravingArea: { x: 27, y: 45, width: 46, height: 46 },
  },
  diamond: {
    id: 'diamond',
    label: 'Diamond',
    path: 'M50 21 L90 66 L50 111 L10 66 Z',
    engravingArea: { x: 27, y: 48, width: 46, height: 46 },
  },
  square: {
    id: 'square',
    label: 'Square',
    path: roundedRectPath(10, 26, 80, 80, 12),
    engravingArea: { x: 20, y: 36, width: 60, height: 60 },
  },
  circle: {
    id: 'circle',
    label: 'Circle',
    path: ellipsePath(50, 66, 45, 45),
    engravingArea: { x: 17, y: 33, width: 66, height: 66 },
  },
  oval: {
    id: 'oval',
    label: 'Oval',
    path: ellipsePath(50, 66, 32, 44),
    engravingArea: { x: 24, y: 34, width: 52, height: 64 },
  },
  rectangle: {
    id: 'rectangle',
    label: 'Rectangle',
    path: roundedRectPath(22, 24, 56, 84, 12),
    engravingArea: { x: 29, y: 34, width: 42, height: 64 },
  },
  hexagon: {
    id: 'hexagon',
    label: 'Hexagon',
    path: 'M50 21 L88.97 43.5 L88.97 88.5 L50 111 L11.03 88.5 L11.03 43.5 Z',
    engravingArea: { x: 22, y: 38, width: 56, height: 56 },
  },
};

export const PENDANT_SHAPE_LIST: PendantShape[] = Object.values(PENDANT_SHAPES);

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
