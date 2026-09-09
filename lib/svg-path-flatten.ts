/**
 * Flattens an SVG path `d` string into polylines — arrays of `{x,y}` points.
 *
 * Needed because two things in this app produce real curves (cubic Béziers
 * from potrace's traced engraving, elliptical arcs from our own pendant
 * shapes) but DXF has no path/Bézier primitive of its own: a laser cutter
 * wants points, not curve mathematics. This is the one place both curve
 * families get reduced to the same thing, so the DXF writer only ever has to
 * emit `LWPOLYLINE` entities.
 *
 * Isomorphic — no DOM, no Node APIs — so it can run in the export route
 * without pulling anything server-specific into its logic.
 */

import parseSvgPath from 'parse-svg-path';

export interface Point {
  x: number;
  y: number;
}

/** One subpath: a run of points from one `M` to the next (or to `Z`/end). */
export type Polyline = Point[];

const BEZIER_STEPS = 24;
const ARC_STEPS = 32;

function cubicPoint(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

function quadPoint(p0: Point, p1: Point, p2: Point, t: number): Point {
  const mt = 1 - t;
  return {
    x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
    y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y,
  };
}

/** Signed angle from vector u to vector v, in radians. */
function angleBetween(ux: number, uy: number, vx: number, vy: number): number {
  const sign = ux * vy - uy * vx < 0 ? -1 : 1;
  const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
  if (len === 0) return 0;
  const dot = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / len));
  return sign * Math.acos(dot);
}

/**
 * Endpoint-to-center arc parameterization, per the SVG 1.1 spec (appendix
 * F.6.5). `A rx ry xAxisRotation largeArcFlag sweepFlag x y` describes the arc
 * by its two endpoints; a laser cutter (and DXF) wants points along it.
 */
function flattenArc(
  start: Point,
  rxIn: number,
  ryIn: number,
  xAxisRotationDeg: number,
  largeArcFlag: number,
  sweepFlag: number,
  end: Point,
): Point[] {
  if (rxIn === 0 || ryIn === 0 || (start.x === end.x && start.y === end.y)) {
    return [end];
  }

  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  const phi = (xAxisRotationDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  const dx2 = (start.x - end.x) / 2;
  const dy2 = (start.y - end.y) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    rx *= scale;
    ry *= scale;
  }

  const sign = largeArcFlag !== sweepFlag ? 1 : -1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = sign * Math.sqrt(Math.max(0, num / den));
  const cxp = (co * (rx * y1p)) / ry;
  const cyp = (-co * (ry * x1p)) / rx;

  const cx = cosPhi * cxp - sinPhi * cyp + (start.x + end.x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (start.y + end.y) / 2;

  const theta1 = angleBetween(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dtheta = angleBetween((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (sweepFlag === 0 && dtheta > 0) dtheta -= 2 * Math.PI;
  if (sweepFlag === 1 && dtheta < 0) dtheta += 2 * Math.PI;

  const points: Point[] = [];
  for (let i = 1; i <= ARC_STEPS; i++) {
    const t = i / ARC_STEPS;
    const angle = theta1 + t * dtheta;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    points.push({
      x: cx + rx * cosPhi * cosA - ry * sinPhi * sinA,
      y: cy + rx * sinPhi * cosA + ry * cosPhi * sinA,
    });
  }
  // Floating point can leave the last sample a hair off the true endpoint.
  points[points.length - 1] = end;
  return points;
}

/**
 * Flatten a `d` attribute into one or more polylines. Handles M/L/H/V/C/Q/A/Z,
 * absolute and relative, which covers everything both our own hand-written
 * shape paths and potrace's traced output ever emit. `S`/`T` (smooth curve
 * shorthands) are not needed by either producer and are intentionally
 * unsupported rather than silently approximated.
 */
export function flattenPath(d: string): Polyline[] {
  const commands = parseSvgPath(d);
  const polylines: Polyline[] = [];
  let current: Polyline = [];
  let cur: Point = { x: 0, y: 0 };
  let start: Point = { x: 0, y: 0 };

  const push = (p: Point) => {
    current.push(p);
    cur = p;
  };

  for (const [rawCmd, ...args] of commands) {
    const isRelative = rawCmd === rawCmd.toLowerCase();
    const cmd = rawCmd.toUpperCase();
    const point = (x: number, y: number): Point =>
      isRelative ? { x: cur.x + x, y: cur.y + y } : { x, y };

    switch (cmd) {
      case 'M': {
        if (current.length) polylines.push(current);
        current = [];
        const p = point(args[0], args[1]);
        push(p);
        start = p;
        break;
      }
      case 'L':
        push(point(args[0], args[1]));
        break;
      case 'H':
        push({ x: isRelative ? cur.x + args[0] : args[0], y: cur.y });
        break;
      case 'V':
        push({ x: cur.x, y: isRelative ? cur.y + args[0] : args[0] });
        break;
      case 'C': {
        const from = cur;
        const p1 = point(args[0], args[1]);
        const p2 = point(args[2], args[3]);
        const p3 = point(args[4], args[5]);
        for (let i = 1; i <= BEZIER_STEPS; i++) {
          push(cubicPoint(from, p1, p2, p3, i / BEZIER_STEPS));
        }
        break;
      }
      case 'Q': {
        const from = cur;
        const p1 = point(args[0], args[1]);
        const p2 = point(args[2], args[3]);
        for (let i = 1; i <= BEZIER_STEPS; i++) {
          push(quadPoint(from, p1, p2, i / BEZIER_STEPS));
        }
        break;
      }
      case 'A': {
        const [rx, ry, xrot, largeArc, sweep, ex, ey] = args;
        const end = point(ex, ey);
        for (const p of flattenArc(cur, rx, ry, xrot, largeArc, sweep, end)) push(p);
        break;
      }
      case 'Z': {
        if (current.length) current.push({ ...start });
        polylines.push(current);
        current = [];
        cur = start;
        break;
      }
      default:
        // S/T: unused by every path this app ever flattens (see doc comment).
        break;
    }
  }

  if (current.length) polylines.push(current);
  return polylines;
}

export function boundsOf(polylines: Polyline[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const line of polylines) {
    for (const p of line) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return { minX, minY, maxX, maxY };
}
