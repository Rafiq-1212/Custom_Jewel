'use client';

/**
 * Shared binary-mask and contour-tracing primitives used by both silhouette
 * extractors:
 *
 *   lib/edge-cut-contour.ts  — traces the *sketch's* ink (sparse line art,
 *                              needs heavy bridging dilation).
 *   lib/photo-silhouette.ts  — traces the *original photo's* subject (a
 *                              background-removed mask, needs hole-closing
 *                              more than bridging).
 *
 * Both need the same morphology/tracing/simplification pipeline; this module
 * exists so that pipeline is written exactly once. Pure array math — no
 * canvas, no image decoding — so it stays trivially unit-testable and has no
 * opinion about where its input masks come from.
 */

import type { Point } from './pendant-geometry';

/** Sliding-window maximum over `input` with a window radius of `radius` — O(n), not O(n*radius). */
function slidingMax(input: Uint8Array, n: number, radius: number): Uint8Array {
  const output = new Uint8Array(n);
  const deque = new Int32Array(n + radius);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n + radius; i++) {
    if (i < n) {
      while (tail > head && input[deque[tail - 1]] <= input[i]) tail--;
      deque[tail++] = i;
    }
    while (deque[head] < i - radius) head++;
    const target = i - radius;
    if (target >= 0) output[target] = input[deque[head]];
  }
  return output;
}

/** Sliding-window minimum — same algorithm as `slidingMax`, inverted comparison. */
function slidingMin(input: Uint8Array, n: number, radius: number): Uint8Array {
  const output = new Uint8Array(n);
  const deque = new Int32Array(n + radius);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n + radius; i++) {
    if (i < n) {
      while (tail > head && input[deque[tail - 1]] >= input[i]) tail--;
      deque[tail++] = i;
    }
    while (deque[head] < i - radius) head++;
    const target = i - radius;
    if (target >= 0) output[target] = input[deque[head]];
  }
  return output;
}

function separableFilter(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
  pass1D: (input: Uint8Array, n: number, radius: number) => Uint8Array,
): Uint8Array {
  if (radius <= 0) return mask;

  const rowPass = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = mask.subarray(y * width, y * width + width);
    rowPass.set(pass1D(row, width, radius), y * width);
  }

  const colPass = new Uint8Array(width * height);
  const col = new Uint8Array(height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) col[y] = rowPass[y * width + x];
    const filteredCol = pass1D(col, height, radius);
    for (let y = 0; y < height; y++) colPass[y * width + x] = filteredCol[y];
  }
  return colPass;
}

/** Separable box dilation (grows foreground regions) — bridges gaps, merges nearby blobs. */
export function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  return separableFilter(mask, width, height, radius, slidingMax);
}

/** Separable box erosion (shrinks foreground regions) — the inverse of `dilate`. */
export function erode(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  return separableFilter(mask, width, height, radius, slidingMin);
}

/**
 * Morphological "close": dilate then erode by the same radius. Fills small
 * interior holes and gaps (e.g. a strand of hair letting background show
 * through) without meaningfully growing the overall outer boundary — unlike
 * a one-way `dilate`, which is what `lib/edge-cut-contour.ts` wants instead
 * (it needs to *grow* sparse ink into a blob, not just patch holes in an
 * already-solid one).
 */
export function closeMask(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return mask;
  return erode(dilate(mask, width, height, radius), width, height, radius);
}

/**
 * Keeps only the largest 8-connected component. This is the mechanism behind
 * "avoid the artwork accidentally becoming several disconnected pendant
 * pieces" — rather than guessing which fragments matter, only the single
 * biggest connected mass survives, which after adequate bridging/closing is
 * normally the entire intended composition.
 */
export function largestComponentMask(mask: Uint8Array, width: number, height: number): Uint8Array {
  const labels = new Int32Array(width * height).fill(-1);
  const stack = new Int32Array(width * height);
  const sizes: number[] = [];
  let bestId = -1;
  let bestSize = 0;

  for (let start = 0; start < width * height; start++) {
    if (mask[start] === 0 || labels[start] !== -1) continue;
    const id = sizes.length;
    let size = 0;
    let stackLen = 0;
    stack[stackLen++] = start;
    labels[start] = id;

    while (stackLen > 0) {
      const idx = stack[--stackLen];
      size++;
      const x = idx % width;
      const y = (idx / width) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const nIdx = ny * width + nx;
          if (mask[nIdx] === 1 && labels[nIdx] === -1) {
            labels[nIdx] = id;
            stack[stackLen++] = nIdx;
          }
        }
      }
    }

    sizes.push(size);
    if (size > bestSize) {
      bestSize = size;
      bestId = id;
    }
  }

  const out = new Uint8Array(width * height);
  if (bestId === -1) return out;
  for (let i = 0; i < width * height; i++) out[i] = labels[i] === bestId ? 1 : 0;
  return out;
}

/** The mask's foreground bounding box, in mask-pixel coordinates. `null` if the mask is empty. */
export function boundingBoxOf(
  mask: Uint8Array,
  width: number,
  height: number,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 1) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX === -1 ? null : { minX, minY, maxX, maxY };
}

/** The foreground's horizontal extent at a given row. `null` if that row has no foreground pixels. */
export function rowExtent(
  mask: Uint8Array,
  width: number,
  row: number,
): { minX: number; maxX: number } | null {
  let minX = -1;
  let maxX = -1;
  const offset = row * width;
  for (let x = 0; x < width; x++) {
    if (mask[offset + x] === 1) {
      if (minX === -1) minX = x;
      maxX = x;
    }
  }
  return minX === -1 ? null : { minX, maxX };
}

/** Clockwise 8-neighbor offsets starting at North, for Moore-Neighbor boundary tracing. */
const DIRS: Point[] = [
  { x: 0, y: -1 },
  { x: 1, y: -1 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
  { x: -1, y: 1 },
  { x: -1, y: 0 },
  { x: -1, y: -1 },
];

function isForeground(mask: Uint8Array, width: number, height: number, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  return mask[y * width + x] === 1;
}

/**
 * Moore-Neighbor tracing of the mask's single outer boundary. Interior holes
 * (e.g. the gap between an arm and a torso) are deliberately never traced —
 * only the outermost contour — so the result stays one solid silhouette
 * rather than acquiring small internal cutouts a laser cutter would have to
 * treat as separate closed paths.
 */
export function traceOuterBoundary(mask: Uint8Array, width: number, height: number): Point[] | null {
  let startX = -1;
  let startY = -1;
  outer: for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 1) {
        startX = x;
        startY = y;
        break outer;
      }
    }
  }
  if (startX === -1) return null;

  const boundary: Point[] = [{ x: startX, y: startY }];
  let curX = startX;
  let curY = startY;
  // The pixel to the west of the topmost-leftmost foreground pixel is
  // guaranteed background — a safe starting point to resume the clockwise
  // search from.
  let backtrackDir = 6;
  const maxSteps = 8 * (width + height) + 64;

  for (let step = 0; step < maxSteps; step++) {
    let foundDir = -1;
    let nx = curX;
    let ny = curY;
    for (let k = 1; k <= 8; k++) {
      const d = (backtrackDir + k) % 8;
      const cx = curX + DIRS[d].x;
      const cy = curY + DIRS[d].y;
      if (isForeground(mask, width, height, cx, cy)) {
        foundDir = d;
        nx = cx;
        ny = cy;
        break;
      }
    }
    if (foundDir === -1) break; // an isolated single pixel — nothing to walk around

    curX = nx;
    curY = ny;
    backtrackDir = (foundDir + 4) % 8;
    if (curX === startX && curY === startY) break;
    boundary.push({ x: curX, y: curY });
  }

  return boundary.length >= 3 ? boundary : null;
}

function perpendicularDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared;
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return Math.hypot(p.x - projX, p.y - projY);
}

/** Ramer-Douglas-Peucker polyline simplification — removes pixel-grid jaggedness. */
export function rdpSimplify(points: Point[], epsilon: number): Point[] {
  if (points.length < 3) return points;
  const end = points.length - 1;
  let maxDist = 0;
  let index = 0;
  for (let i = 1; i < end; i++) {
    const d = perpendicularDistance(points[i], points[0], points[end]);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }
  if (maxDist > epsilon) {
    const left = rdpSimplify(points.slice(0, index + 1), epsilon);
    const right = rdpSimplify(points.slice(index), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [points[0], points[end]];
}

/** Chaikin corner-cutting — turns the simplified polygon into an organic, jewellery-clean curve. */
export function chaikinSmooth(points: Point[], iterations: number): Point[] {
  let current = points;
  for (let iter = 0; iter < iterations; iter++) {
    const next: Point[] = [];
    const n = current.length;
    for (let i = 0; i < n; i++) {
      const p0 = current[i];
      const p1 = current[(i + 1) % n];
      next.push({ x: 0.75 * p0.x + 0.25 * p1.x, y: 0.75 * p0.y + 0.25 * p1.y });
      next.push({ x: 0.25 * p0.x + 0.75 * p1.x, y: 0.25 * p0.y + 0.75 * p1.y });
    }
    current = next;
  }
  return current;
}

/**
 * The full trace -> simplify -> smooth pipeline, shared by both extractors
 * once they each have their own cleaned-up binary mask ready.
 */
export function maskToSmoothContour(mask: Uint8Array, width: number, height: number): Point[] | null {
  const traced = traceOuterBoundary(mask, width, height);
  if (!traced) return null;
  const epsilon = Math.max(1, Math.max(width, height) * 0.004);
  const simplified = rdpSimplify(traced, epsilon);
  return chaikinSmooth(simplified, 2);
}

/** How much of the raw foreground mask the single largest closed-and-kept component must retain. */
const COVERAGE_TARGET = 0.92;
/** Successive close radii to try, as a fraction of the mask's larger dimension. */
const CLOSE_RADIUS_STEPS = [0.02, 0.035, 0.055, 0.08, 0.11];

/**
 * A fixed close radius doesn't generalize: verified directly that even a
 * radius already 3x larger than a first guess still left a real customer
 * photo with the face traced as a disconnected island from the body — real
 * lighting (warm indoor light shifting skin tones toward the backdrop, a
 * shadow at the jawline, hair meeting a dim background — or, for a remove.bg
 * result, a soft/anti-aliased matte edge) varies too much to cover with one
 * constant. Instead of guessing a bigger constant and hoping, this searches:
 * try the smallest close radius first, and only grow it if the result
 * actually lost a meaningful share of the original foreground pixels to
 * fragmentation (measured directly — a real, checkable signal, not a guess)
 * — stopping as soon as a radius recovers `COVERAGE_TARGET` of the raw mask
 * into one connected piece, so a mask that was already clean never gets
 * over-smoothed just because a later step in the list exists.
 *
 * Shared by lib/photo-silhouette.ts (a locally-segmented photo mask) and
 * lib/remove-bg-contour.ts (a remove.bg alpha mask) — both need "turn a
 * mostly-good foreground mask into one solid, connected piece", just from
 * masks produced by two different upstream sources.
 */
export function closeToSingleComponent(rawMask: Uint8Array, width: number, height: number): Uint8Array {
  let totalForeground = 0;
  for (let i = 0; i < rawMask.length; i++) totalForeground += rawMask[i];
  if (totalForeground === 0) return rawMask;

  let best = rawMask;
  let bestCoverage = 0;

  for (const fraction of CLOSE_RADIUS_STEPS) {
    const radius = Math.max(4, Math.round(Math.max(width, height) * fraction));
    const closed = closeMask(rawMask, width, height, radius);
    const kept = largestComponentMask(closed, width, height);

    let keptCount = 0;
    for (let i = 0; i < kept.length; i++) keptCount += kept[i];
    const coverage = keptCount / totalForeground;

    if (coverage > bestCoverage) {
      best = kept;
      bestCoverage = coverage;
    }
    if (coverage >= COVERAGE_TARGET) break;
  }

  return best;
}
