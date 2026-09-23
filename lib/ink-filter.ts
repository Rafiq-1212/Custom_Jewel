/**
 * A "photocopy" style comic ink filter: turns the enhanced photo into a rough
 * black-and-white trace whose lines sit exactly on the photo's own edges.
 * The trace is then handed to the AI finishing step (lib/sketch-pipeline.ts),
 * which cleans it up without moving the lines, so the likeness is locked to
 * the real photo instead of being redrawn.
 *
 * Rule per pixel, tuned against the client's reference artwork:
 *   - ink where the pixel is clearly darker than its own neighbourhood
 *     (local contrast), so features and folds show on light skin and dark
 *     cloth alike, while flat areas of any brightness stay white;
 *   - solid ink where the area is genuinely dark (hair, beard, deep shadow),
 *     except bright ridges inside it, which stay white as hair highlights;
 *   - near-white regions connected to the image border are background and
 *     stay white.
 * Tiny specks and pinholes are removed at the end.
 *
 * Pure computation on a raw pixel buffer from sharp. Server only.
 */

import sharp from 'sharp';
import { roundClose, squaredDistanceTo } from './distance-transform';

if (typeof window !== 'undefined') {
  throw new Error('lib/ink-filter.ts was imported into a browser bundle. This module is server-only.');
}

/**
 * Resolution the trace is made at, matching the 2K photo from the enhance
 * step. The pixel-based settings below were tuned at 1300 px wide and are
 * scaled by SCALE so the filter behaves the same, just with more detail.
 */
const WORK_WIDTH = 2400;
const SCALE = WORK_WIDTH / 1300;
/** Blur that removes pixel noise before comparing against the neighbourhood. */
const DETAIL_SIGMA = 0.7 * SCALE;
/** Size of the "neighbourhood" a pixel is compared with. */
const NEIGHBOURHOOD_SIGMA = 7 * SCALE;
/** Blur used to judge whether an area is genuinely dark. */
const TONE_SIGMA = 1.2 * SCALE;
/** Ink where the pixel is below this fraction of its neighbourhood's brightness. */
const LINE_RATIO = 0.87;
/** Inside dark areas, keep pixels above this fraction of the neighbourhood white (hair highlights). */
const HIGHLIGHT_RATIO = 1.12;
/**
 * Solid ink where the normalised tone is below this.
 *
 * Kept low on purpose. At 0.3 a dark garment — a navy blouse, a dark saree
 * border — came out as one solid black mass: it swallowed a hand resting on
 * a shoulder, and it is expensive to engrave, since the laser has to clear
 * the whole area instead of following strokes. At 0.2 the same garment
 * opens up into its weave and embroidery while genuinely black things (hair,
 * a pupil, deep shadow) still fill, because they sit far below it. Measured
 * on a real customer photo: ink coverage 14.5% -> 12.1%.
 */
const DARK_TONE = 0.2;
/** Background: near-white pixels connected to the image border. */
const BACKGROUND_LUMINANCE = 0.93;
/**
 * Isolated ink smaller than this is noise. Kept fairly large on purpose: the
 * finishing step tends to redraw leftover specks as moles or dots.
 */
const MIN_INK_SPECK = Math.round(40 * SCALE * SCALE);
const MIN_WHITE_PINHOLE = Math.round(10 * SCALE * SCALE);

/**
 * The artwork is engraved into gold or silver, and on polished metal a stray
 * speck or a two-millimetre dash does not read as fabric texture — it reads
 * as a scratch, and the laser still has to fire on it. So OUTSIDE the faces
 * the cleanup is much harder: any isolated fragment smaller than this goes.
 * Measured on a couple photo, fragments 408 -> about 80, the scattered weave
 * across a kurta gone, the fold lines kept because they are long.
 *
 * Never applied to faces. There, a fragment that small can be a kumkum dot,
 * a bindi, or on a small face in a group photo a whole eyebrow; the same cut
 * applied everywhere erased all three in testing.
 */
const MIN_CLOTH_FRAGMENT = Math.round(400 * SCALE * SCALE);
/**
 * Outside the faces, a solid dark area is hollowed to a border this thick.
 * A filled patch has to be burned out in full, which is slow, and on metal it
 * comes out as a blotchy matte slab; its outline carries the shape. Lines up
 * to twice this thick are untouched, so folds and seams keep their weight.
 * Hair and beards sit inside the faces and stay solid.
 */
const HOLLOW_BORDER = 12 * SCALE;
/**
 * Gaps narrower than twice this are bridged before deciding what is "solid",
 * so a dense crosshatch of shadow — a fold of dark cloth reads that way — is
 * hollowed like a filled patch instead of engraving as a block of mesh. Only
 * the decision uses the bridged shape; the ink kept is the original.
 */
const MESH_BRIDGE = 4 * SCALE;

/** A region of the photo, as fractions of its width and height. */
export interface Region {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function gaussianBlur(src: Float32Array, width: number, height: number, sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    kernel[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma));
    sum += kernel[i + radius];
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

  const tmp = new Float32Array(width * height);
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let s = 0;
      for (let i = -radius; i <= radius; i++) s += src[row + Math.min(width - 1, Math.max(0, x + i))] * kernel[i + radius];
      tmp[row + x] = s;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let s = 0;
      for (let i = -radius; i <= radius; i++) s += tmp[Math.min(height - 1, Math.max(0, y + i)) * width + x] * kernel[i + radius];
      out[y * width + x] = s;
    }
  }
  return out;
}

/**
 * Flips 4-connected regions of `target` smaller than `minSize` pixels. A
 * region touching any `spare` pixel is left alone.
 */
function removeSmallRegions(ink: Uint8Array, width: number, height: number, target: 0 | 1, minSize: number, spare?: Uint8Array): void {
  const n = width * height;
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const region = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (seen[start] || ink[start] !== target) continue;
    let size = 0;
    let top = 0;
    let spared = false;
    stack[top++] = start;
    seen[start] = 1;
    while (top) {
      const i = stack[--top];
      region[size++] = i;
      if (spare && spare[i]) spared = true;
      const x = i % width;
      if (x > 0 && !seen[i - 1] && ink[i - 1] === target) { seen[i - 1] = 1; stack[top++] = i - 1; }
      if (x < width - 1 && !seen[i + 1] && ink[i + 1] === target) { seen[i + 1] = 1; stack[top++] = i + 1; }
      if (i >= width && !seen[i - width] && ink[i - width] === target) { seen[i - width] = 1; stack[top++] = i - width; }
      if (i < n - width && !seen[i + width] && ink[i + width] === target) { seen[i + width] = 1; stack[top++] = i + width; }
    }
    if (size < minSize && !spared) for (let j = 0; j < size; j++) ink[region[j]] = target === 1 ? 0 : 1;
  }
}

/** Marks every pixel of each 4-connected region of `mask` that contains at least one `seed` pixel. */
function touchingRegions(mask: Uint8Array, width: number, height: number, seed: Uint8Array): Uint8Array {
  const n = width * height;
  const out = new Uint8Array(n);
  const stack = new Int32Array(n);
  let top = 0;
  for (let i = 0; i < n; i++) if (mask[i] && seed[i] && !out[i]) { out[i] = 1; stack[top++] = i; }
  while (top) {
    const i = stack[--top];
    const x = i % width;
    for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i >= width ? i - width : -1, i < n - width ? i + width : -1]) {
      if (j >= 0 && mask[j] && !out[j]) { out[j] = 1; stack[top++] = j; }
    }
  }
  return out;
}

/**
 * Ink trace of `photo` as a black-on-white PNG. `faces` marks the areas traced
 * exactly as they are; everything else is cleaned up for engraving (see
 * MIN_CLOTH_FRAGMENT and HOLLOW_BORDER). Without it, the whole photo is
 * treated as face — the safe way round.
 */
export async function roughInkTrace(photo: Buffer, faces?: Region[]): Promise<Buffer> {
  const { data, info } = await sharp(photo)
    .flatten({ background: '#ffffff' })
    .resize({ width: WORK_WIDTH, withoutEnlargement: false })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  const n = width * height;
  const channels = info.channels;

  const luminance = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p++, i += channels) {
    luminance[p] = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
  }

  // Background: near-white and connected to the border.
  const background = new Uint8Array(n);
  const stack = new Int32Array(n);
  let top = 0;
  const claim = (i: number) => {
    if (!background[i] && luminance[i] > BACKGROUND_LUMINANCE) {
      background[i] = 1;
      stack[top++] = i;
    }
  };
  for (let x = 0; x < width; x++) { claim(x); claim(n - width + x); }
  for (let y = 0; y < height; y++) { claim(y * width); claim(y * width + width - 1); }
  while (top) {
    const i = stack[--top];
    const x = i % width;
    if (x > 0) claim(i - 1);
    if (x < width - 1) claim(i + 1);
    if (i >= width) claim(i - width);
    if (i < n - width) claim(i + width);
  }

  // Normalise tones over the subject only (2nd to 98th percentile), so the
  // dark threshold means the same thing whatever the photo's exposure.
  const sample: number[] = [];
  for (let i = 0; i < n; i += 3) if (!background[i]) sample.push(luminance[i]);
  sample.sort((a, b) => a - b);
  const low = sample.length ? sample[Math.floor(sample.length * 0.02)] : 0;
  const high = sample.length ? sample[Math.floor(sample.length * 0.98)] : 1;
  const range = Math.max(0.05, high - low);
  for (let i = 0; i < n; i++) luminance[i] = Math.min(1, Math.max(0, (luminance[i] - low) / range));

  const detail = gaussianBlur(luminance, width, height, DETAIL_SIGMA);
  const neighbourhood = gaussianBlur(luminance, width, height, NEIGHBOURHOOD_SIGMA);
  const tone = gaussianBlur(luminance, width, height, TONE_SIGMA);

  const ink = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (background[i]) continue;
    const ratio = (detail[i] + 0.02) / (neighbourhood[i] + 0.02);
    const line = ratio < LINE_RATIO;
    const darkFill = tone[i] < DARK_TONE && ratio <= HIGHLIGHT_RATIO;
    if (line || darkFill) ink[i] = 1;
  }
  if (faces) {
    const face = new Uint8Array(n);
    for (const r of faces) {
      const x0 = Math.max(0, Math.floor(r.left * width)), x1 = Math.min(width, Math.ceil(r.right * width));
      const y0 = Math.max(0, Math.floor(r.top * height)), y1 = Math.min(height, Math.ceil(r.bottom * height));
      for (let y = y0; y < y1; y++) face.fill(1, y * width + x0, y * width + x1);
    }
    const solid = roundClose(ink, width, height, MESH_BRIDGE);
    // Whole dark regions are hollowed or left alone, never cut part-way:
    // stopping at the edge of a face box leaves a straight line through the
    // cloth, which on metal reads as a machining fault. A region that
    // touches a face at all keeps all its ink.
    const nearFace = touchingRegions(solid, width, height, face);
    const toWhite = squaredDistanceTo(solid, width, height, 0);
    const border2 = HOLLOW_BORDER * HOLLOW_BORDER;
    for (let i = 0; i < n; i++) if (ink[i] && !nearFace[i] && toWhite[i] > border2) ink[i] = 0;
    removeSmallRegions(ink, width, height, 1, MIN_CLOTH_FRAGMENT, face);
  }
  removeSmallRegions(ink, width, height, 1, MIN_INK_SPECK);
  removeSmallRegions(ink, width, height, 0, MIN_WHITE_PINHOLE);

  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = ink[i] ? 0 : 255;
  return sharp(out, { raw: { width, height, channels: 1 } }).png().toBuffer();
}
