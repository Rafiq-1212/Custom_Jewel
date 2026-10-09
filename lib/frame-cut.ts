/**
 * The open windows of a FRAME pendant — the workshop's heart: a band of metal
 * round the edge, the portrait standing inside it, and the space between the
 * two cut clean through. A plain plate had the portrait running to the edge
 * with no space round it at all.
 *
 * Pure geometry on a small raster, in viewBox units in and out, so the
 * preview, the cut layout, the production files and the product photo all get
 * the same windows from lib/pendant-geometry.ts.
 */

import type { Point } from './pendant-geometry';
import { roundDilate, roundErode } from './distance-transform';
import { maskToSmoothContour } from './silhouette-geometry';

/** Raster cells per viewBox unit. At 5 a 25 mm pendant is worked at 0.06 mm. */
const CELLS_PER_UNIT = 5;
/** A window narrower than twice this (viewBox units) is a sliver a cutter cannot make cleanly, and goes. */
const MIN_WINDOW_HALF_WIDTH = 1.1;
/** A window smaller than this (square viewBox units) is dropped. */
const MIN_WINDOW_AREA = 14;

/** Even-odd scanline fill of a closed polygon, in raster cells. */
export function fillPolygon(mask: Uint8Array, width: number, height: number, points: Point[]): void {
  for (let y = 0; y < height; y++) {
    const yc = y + 0.5;
    const crossings: number[] = [];
    for (let i = 0, n = points.length; i < n; i++) {
      const a = points[i];
      const b = points[(i + 1) % n];
      if (a.y <= yc === b.y <= yc) continue;
      crossings.push(a.x + ((yc - a.y) * (b.x - a.x)) / (b.y - a.y));
    }
    crossings.sort((p, q) => p - q);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const from = Math.max(0, Math.ceil(crossings[i] - 0.5));
      const to = Math.min(width - 1, Math.floor(crossings[i + 1] - 0.5));
      if (to >= from) mask.fill(1, y * width + from, y * width + to + 1);
    }
  }
}

/**
 * The windows to cut out of `outer`, as closed curves in viewBox units.
 *
 * A window is what is left of the plate once the frame band and the portrait
 * are taken away. The portrait is `portrait` (its outline, already carrying
 * its own cut margin) AND everything below it: nothing hangs in mid-air in a
 * sheet of metal, so the figure stands on solid metal down to the frame, the
 * way the workshop's piece is solid from the shoulders to the point of the
 * heart.
 */
export function frameWindows(outer: Point[], portrait: Point[], band: number, width: number, height: number): Point[][] {
  const w = Math.round(width * CELLS_PER_UNIT);
  const h = Math.round(height * CELLS_PER_UNIT);
  const scale = (points: Point[]) => points.map((p) => ({ x: p.x * CELLS_PER_UNIT, y: p.y * CELLS_PER_UNIT }));

  const plate = new Uint8Array(w * h);
  fillPolygon(plate, w, h, scale(outer));
  const inside = roundErode(plate, w, h, Math.round(band * CELLS_PER_UNIT));

  const solid = new Uint8Array(w * h);
  fillPolygon(solid, w, h, scale(portrait));
  for (let x = 0; x < w; x++) {
    let below = false;
    for (let y = 0; y < h; y++) {
      if (solid[y * w + x]) below = true;
      else if (below) solid[y * w + x] = 1;
    }
  }

  const open = new Uint8Array(w * h);
  for (let i = 0; i < open.length; i++) open[i] = inside[i] && !solid[i] ? 1 : 0;
  // Opened: slivers go, and what is left keeps its own edge.
  const r = Math.round(MIN_WINDOW_HALF_WIDTH * CELLS_PER_UNIT);
  const opened = roundDilate(roundErode(open, w, h, r), w, h, r);
  for (let i = 0; i < opened.length; i++) opened[i] = opened[i] && open[i] ? 1 : 0;

  // One curve per window.
  const windows: Point[][] = [];
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let start = 0; start < opened.length; start++) {
    if (!opened[start] || seen[start]) continue;
    const piece = new Uint8Array(w * h);
    let area = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop() as number;
      piece[p] = 1;
      area++;
      const x = p % w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
        if (q < 0 || q >= opened.length || seen[q] || !opened[q]) continue;
        seen[q] = 1;
        stack.push(q);
      }
    }
    if (area < MIN_WINDOW_AREA * CELLS_PER_UNIT * CELLS_PER_UNIT) continue;
    const curve = maskToSmoothContour(piece, w, h, { epsilonFraction: 0.0015, smoothingIterations: 2 });
    if (curve && curve.length >= 3) windows.push(curve.map((p) => ({ x: p.x / CELLS_PER_UNIT, y: p.y / CELLS_PER_UNIT })));
  }
  return windows;
}
