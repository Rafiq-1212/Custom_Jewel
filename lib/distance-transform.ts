/**
 * Exact Euclidean distance transform (Felzenszwalb & Huttenlocher's
 * separable lower-envelope-of-parabolas algorithm, O(n)) and the two
 * morphology operations built on it — dilation and erosion with a ROUND
 * structuring element.
 *
 * Why this exists next to the box-filter `dilate`/`erode` in
 * lib/silhouette-geometry.ts: a box (separable max/min) offsets a shape by a
 * square, so every convex corner of the outline grows into a squared-off
 * lump and concave corners fill in as chamfers. The client's cut lines are
 * true offset curves — a constant distance from the ink, with round joins —
 * and "every pixel within r of the ink" is exactly that, which is what a
 * thresholded distance transform gives.
 *
 * No DOM or Node dependency; pure typed-array maths.
 */

const INF = 1e20;

/** 1-D squared-distance transform of `f` (in place into `d`), sampled at integer positions. */
function transform1d(f: Float32Array, n: number, d: Float32Array, v: Int32Array, z: Float32Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dx = q - v[k];
    d[q] = dx * dx + f[v[k]];
  }
}

/**
 * Squared Euclidean distance from every pixel to the nearest pixel whose
 * mask value equals `target` (1 = nearest foreground, 0 = nearest background).
 */
export function squaredDistanceTo(mask: Uint8Array, width: number, height: number, target: 0 | 1): Float32Array {
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = mask[i] === target ? 0 : INF;

  const n = Math.max(width, height);
  const f = new Float32Array(n);
  const d = new Float32Array(n);
  const v = new Int32Array(n);
  const z = new Float32Array(n + 1);

  // Columns, then rows — the 2-D transform is separable.
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = out[y * width + x];
    transform1d(f, height, d, v, z);
    for (let y = 0; y < height; y++) out[y * width + x] = d[y];
  }
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) f[x] = out[row + x];
    transform1d(f, width, d, v, z);
    for (let x = 0; x < width; x++) out[row + x] = d[x];
  }
  return out;
}

/** Grows the foreground by a disc of the given radius — a true rounded offset. */
export function roundDilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return mask;
  const dist = squaredDistanceTo(mask, width, height, 1);
  const r2 = radius * radius;
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = dist[i] <= r2 ? 1 : 0;
  return out;
}

/** Shrinks the foreground by a disc of the given radius — the exact inverse offset of `roundDilate`. */
export function roundErode(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return mask;
  const dist = squaredDistanceTo(mask, width, height, 0);
  const r2 = radius * radius;
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = dist[i] > r2 ? 1 : 0;
  return out;
}

/** Round close: fills concavities and pinholes narrower than 2·radius without moving the outline elsewhere. */
export function roundClose(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return mask;
  return roundErode(roundDilate(mask, width, height, radius), width, height, radius);
}
