/**
 * Minimal DXF (AutoCAD Drawing Exchange Format) writer.
 *
 * Laser cutters (LightBurn, RDWorks, LaserGRBL, …) read DXF as one of their
 * few genuinely native vector formats — unlike a Rhino .3dm, which is a 3D
 * CAD interchange format no laser controller consumes directly. This writer
 * targets exactly what a laser job needs and nothing else: `LWPOLYLINE` for
 * every cut/engrave outline and `CIRCLE` for round features, on two layers
 * (CUT for the pendant perimeter and bail, ENGRAVE for the artwork) so the
 * two operations can be assigned different laser power/speed in the cutter's
 * own software.
 *
 * DXF is a plain-text, well-documented format (the ASCII "group code / value"
 * pair structure below is the minimal valid R12-compatible subset — no
 * external DXF library pulled in for what is, at its core, string
 * concatenation against a fixed spec).
 */

import type { Point, Polyline } from './svg-path-flatten';

export type DxfLayer = 'CUT' | 'ENGRAVE';

function line(code: number, value: string | number): string {
  return `${code}\n${value}\n`;
}

function header(minX: number, minY: number, maxX: number, maxY: number): string {
  return (
    line(0, 'SECTION') +
    line(2, 'HEADER') +
    line(9, '$ACADVER') +
    line(1, 'AC1009') +
    line(9, '$INSUNITS') +
    line(70, 4) + // 4 = millimeters
    line(9, '$EXTMIN') +
    line(10, minX) +
    line(20, minY) +
    line(9, '$EXTMAX') +
    line(10, maxX) +
    line(20, maxY) +
    line(0, 'ENDSEC')
  );
}

function tablesSection(): string {
  // Two layers: CUT (perimeter + bail) and ENGRAVE (the artwork), so the
  // laser operator can assign different power/speed to each on import.
  const layer = (name: string, colour: number) =>
    line(0, 'LAYER') + line(2, name) + line(70, 0) + line(62, colour) + line(6, 'CONTINUOUS');

  return (
    line(0, 'SECTION') +
    line(2, 'TABLES') +
    line(0, 'TABLE') +
    line(2, 'LAYER') +
    line(70, 2) +
    layer('CUT', 1) + // red
    layer('ENGRAVE', 5) + // blue
    line(0, 'ENDTAB') +
    line(0, 'ENDSEC')
  );
}

function polylineEntity(points: Polyline, layer: DxfLayer, closed: boolean): string {
  if (points.length < 2) return '';
  let entity =
    line(0, 'LWPOLYLINE') +
    line(8, layer) +
    line(90, points.length) +
    line(70, closed ? 1 : 0);
  for (const p of points) {
    entity += line(10, round(p.x)) + line(20, round(p.y));
  }
  return entity;
}

function circleEntity(center: Point, radius: number, layer: DxfLayer): string {
  return line(0, 'CIRCLE') + line(8, layer) + line(10, round(center.x)) + line(20, round(center.y)) + line(40, round(radius));
}

function round(n: number): string {
  // Six decimal places is far finer than any laser's positioning accuracy;
  // it just avoids DXF readers choking on JS float noise (1.0000000000002).
  return (Math.round(n * 1e6) / 1e6).toString();
}

export interface DxfPolylineSpec {
  points: Polyline;
  layer: DxfLayer;
  closed: boolean;
}

export interface DxfCircleSpec {
  center: Point;
  radius: number;
  layer: DxfLayer;
}

/**
 * Assemble a complete, valid DXF document from already-flattened geometry.
 * Every polyline is expected in the same real-world unit (millimeters) —
 * `buildLaserExportAssets` in `lib/laser-export.ts` is what converts from the
 * pendant's abstract 100 x 116 viewBox into physical size before this is
 * called.
 */
export function buildDxf(
  polylines: DxfPolylineSpec[],
  circles: DxfCircleSpec[],
): string {
  const allPoints = polylines.flatMap((p) => p.points);
  const xs = allPoints.map((p) => p.x).concat(circles.map((c) => c.center.x - c.radius), circles.map((c) => c.center.x + c.radius));
  const ys = allPoints.map((p) => p.y).concat(circles.map((c) => c.center.y - c.radius), circles.map((c) => c.center.y + c.radius));
  // Plain loops, not `Math.min(...xs)` — a detailed real-photo engraving
  // traced by potrace can produce tens of thousands of points, and spreading
  // an array that large as call arguments throws "Maximum call stack size
  // exceeded" (verified directly: a two-person Free Edge Cut sketch hit
  // exactly this on the DXF export path). A loop has no such limit.
  const extent = (values: number[]): { min: number; max: number } => {
    let min = Infinity;
    let max = -Infinity;
    for (const v of values) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return { min, max };
  };
  const { min: minX, max: maxX } = xs.length ? extent(xs) : { min: 0, max: 0 };
  const { min: minY, max: maxY } = ys.length ? extent(ys) : { min: 0, max: 0 };

  let entities = line(0, 'SECTION') + line(2, 'ENTITIES');
  for (const spec of polylines) entities += polylineEntity(spec.points, spec.layer, spec.closed);
  for (const spec of circles) entities += circleEntity(spec.center, spec.radius, spec.layer);
  entities += line(0, 'ENDSEC');

  return header(minX, minY, maxX, maxY) + tablesSection() + entities + line(0, 'EOF');
}
