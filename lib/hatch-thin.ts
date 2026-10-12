/**
 * Hatching thinned out, for the production files only.
 *
 * The drawing shades cloth, necks and arms with fine parallel strokes, about
 * six pixels apart. On screen that reads as grey. The workshop's engraving
 * software shows a file hard-edged — any ink in a pixel makes the pixel
 * black — so at the size of a pendant every stroke comes out wider than it
 * was drawn, the gaps between strokes close, and a striped shirt turns into
 * black bars. A laser does much the same to them.
 *
 * So wherever several fine strokes run side by side, strokes are left out
 * until no two of those remaining are closer than SPACING: every other one
 * of ordinary hatching, two in three of the closest. Nothing else changes:
 * outlines, solid blacks, lone lines, pairs of lines, anything short, and
 * the features of a face stay as drawn.
 *
 * All of it is arithmetic on pixels; no model is asked anything.
 */

import sharp from 'sharp';
import { roundDilate, roundErode } from './distance-transform';
import type { FaceMap } from './face-clean';

if (typeof window !== 'undefined') {
  throw new Error('lib/hatch-thin.ts was imported into a browser bundle. This module is server-only.');
}

/** Alpha at or above this is ink. */
const INK_ALPHA = 96;
/** A stroke is fine if it does not survive an opening of this radius: up to four pixels wide. */
const THIN_RADIUS_PX = 2;
/** The least distance left between two strokes of hatching, as a fraction of the drawing's longer side (13 px in 2125). */
const SPACING = 0.006;
/** Which way a stroke runs is read from the fine ink within this many pixels of each of its pixels. */
const WINDOW = 3;
/** Below this (0 a blob, 1 a perfect line) a pixel has no one direction: it is where strokes cross or meet. */
const COHERENT = 0.4;
/** Two strokes within this angle of each other run the same way. */
const SAME_WAY = Math.PI / 6;
/** This many strokes side by side, the stroke itself included, make hatching; fewer are lines that happen to be close. */
const HATCH_STROKES = 4;
/** A stroke longer than this fraction of the longer side is an outline or a strand of hair, and stays. */
const LONG = 0.07;
/** A stroke shorter than this many pixels is a tick or a dot, and stays. */
const SHORT_PX = 8;
/** A beard is left alone out to this fraction of the face's width beyond its outline; eyes, eyebrows, mouth and marks out to half of it. */
const FACE_MARGIN = 0.12;
/** Bits of ink this small left behind beside a removed stroke go with it. */
const SPECK_PX = 10;
const BINS = 6;

/** `sketch` (the transparent master artwork) with its hatching thinned everywhere but on `faces`. */
export async function thinHatching(sketch: Buffer, faces: FaceMap[]): Promise<Buffer> {
  const { data, info } = await sharp(sketch).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels } = info;
  const size = w * h;
  const spacing = Math.max(6, Math.round(Math.max(w, h) * SPACING));

  const ink = new Uint8Array(size);
  for (let i = 0; i < size; i++) ink[i] = data[i * channels + 3] >= INK_ALPHA ? 1 : 0;
  const thick = roundDilate(roundErode(ink, w, h, THIN_RADIUS_PX), w, h, THIN_RADIUS_PX);
  const thin = new Uint8Array(size);
  for (let i = 0; i < size; i++) thin[i] = ink[i] && !thick[i] ? 1 : 0;

  // On a face, what its own lines are made of is left alone: eyes,
  // eyebrows, mouth, spectacles, marks, and a beard from where it starts.
  // Whatever shading lib/face-clean.ts left on the skin is thinned like the
  // rest.
  const onFace = new Uint8Array(size);
  const block = (left: number, top: number, right: number, bottom: number) => {
    const from = Math.max(0, Math.floor(left));
    const to = Math.min(w - 1, Math.ceil(right));
    for (let y = Math.max(0, Math.floor(top)); y <= Math.min(h - 1, Math.ceil(bottom)); y++) if (to >= from) onFace.fill(1, y * w + from, y * w + to + 1);
  };
  for (const face of faces) {
    const outline = face.agreed ? [...face.skin, ...face.agreed] : face.skin;
    const xs = outline.map((p) => p.x * w);
    const ys = outline.map((p) => p.y * h);
    const margin = (Math.max(...xs) - Math.min(...xs)) * FACE_MARGIN;
    for (const box of [...face.eyes, ...face.brows, ...face.solid]) block(box.left * w - margin / 2, box.top * h - margin / 2, box.right * w + margin / 2, box.bottom * h + margin / 2);
    if (face.beardFrom !== null) block(Math.min(...xs) - margin, face.beardFrom * h, Math.max(...xs) + margin, Math.max(...ys) + margin);
  }

  // Which way each fine pixel runs: the long axis of the fine ink round it.
  // NaN where it has no one direction.
  const angle = new Float32Array(size).fill(NaN);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!thin[y * w + x]) continue;
      let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
      for (let dy = -WINDOW; dy <= WINDOW; dy++) {
        const py = y + dy;
        if (py < 0 || py >= h) continue;
        for (let dx = -WINDOW; dx <= WINDOW; dx++) {
          const px = x + dx;
          if (px < 0 || px >= w || !thin[py * w + px]) continue;
          n++;
          sx += dx;
          sy += dy;
          sxx += dx * dx;
          syy += dy * dy;
          sxy += dx * dy;
        }
      }
      const vxx = sxx / n - (sx / n) ** 2;
      const vyy = syy / n - (sy / n) ** 2;
      const vxy = sxy / n - (sx / n) * (sy / n);
      const swing = Math.hypot(vxx - vyy, 2 * vxy);
      if (vxx + vyy > 0 && swing / (vxx + vyy) >= COHERENT) angle[y * w + x] = 0.5 * Math.atan2(2 * vxy, vxx - vyy);
    }
  }
  const sameWay = (a: number, b: number) => {
    const d = Math.abs(a - b) % Math.PI;
    return Math.min(d, Math.PI - d) < SAME_WAY;
  };

  // A pixel is in hatching when a probe straight across its stroke meets
  // enough other strokes running the same way.
  const hatching = new Uint8Array(size);
  const reach = spacing * 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = angle[y * w + x];
      if (Number.isNaN(a)) continue;
      const ax = -Math.sin(a);
      const ay = Math.cos(a);
      let strokes = 1;
      for (const side of [1, -1]) {
        let inside = true;
        for (let t = 1; t <= reach && strokes < HATCH_STROKES; t++) {
          const px = Math.round(x + ax * t * side);
          const py = Math.round(y + ay * t * side);
          if (px < 0 || py < 0 || px >= w || py >= h) break;
          const other = angle[py * w + px];
          const on = !Number.isNaN(other) && sameWay(a, other);
          if (on && !inside) strokes++;
          inside = on;
        }
      }
      if (strokes >= HATCH_STROKES) hatching[y * w + x] = 1;
    }
  }

  // The strokes: runs of pixels that go on the same way from one to the next.
  interface Stroke {
    pixels: number[];
    bin: number;
    thinned: boolean;
  }
  const strokes: Stroke[] = [];
  const seen = new Uint8Array(size);
  const longest = Math.max(w, h) * LONG;
  for (let start = 0; start < size; start++) {
    if (seen[start] || Number.isNaN(angle[start])) continue;
    const pixels: number[] = [];
    const stack = [start];
    seen[start] = 1;
    let left = w, right = 0, top = h, bottom = 0, hatched = 0, faced = 0, cos = 0, sin = 0;
    while (stack.length) {
      const p = stack.pop() as number;
      pixels.push(p);
      const x = p % w;
      const y = (p - x) / w;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      hatched += hatching[p];
      faced += onFace[p];
      cos += Math.cos(2 * angle[p]);
      sin += Math.sin(2 * angle[p]);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const qx = x + dx;
          const qy = y + dy;
          if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
          const q = qy * w + qx;
          if (seen[q] || Number.isNaN(angle[q]) || !sameWay(angle[p], angle[q])) continue;
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    const length = Math.hypot(right - left + 1, bottom - top + 1);
    const mean = (0.5 * Math.atan2(sin, cos) + Math.PI) % Math.PI;
    strokes.push({
      pixels,
      bin: Math.min(BINS - 1, Math.floor((mean / Math.PI) * BINS)),
      thinned: hatched * 2 >= pixels.length && faced * 4 < pixels.length && length >= SHORT_PX && length <= longest,
    });
  }

  // What is already there to keep clear of, by the way it runs.
  const near = Array.from({ length: BINS }, () => new Uint8Array(size));
  const spans: number[] = [];
  for (let dy = -(spacing - 1); dy <= spacing - 1; dy++) spans.push(Math.floor(Math.sqrt((spacing - 1) ** 2 - dy * dy)));
  const stamp = (stroke: Stroke) => {
    const mask = near[stroke.bin];
    for (const p of stroke.pixels) {
      const x = p % w;
      const y = (p - x) / w;
      for (let dy = -(spacing - 1); dy <= spacing - 1; dy++) {
        const py = y + dy;
        if (py < 0 || py >= h) continue;
        const half = spans[dy + spacing - 1];
        mask.fill(1, py * w + Math.max(0, x - half), py * w + Math.min(w - 1, x + half) + 1);
      }
    }
  };
  for (const stroke of strokes) if (!stroke.thinned) stamp(stroke);

  // Top to bottom, a stroke of hatching stays unless one running the same
  // way is already too close along most of its length.
  const gone = new Uint8Array(size);
  let dropped = 0;
  for (const stroke of strokes) {
    if (!stroke.thinned) continue;
    const beside = [near[stroke.bin], near[(stroke.bin + 1) % BINS], near[(stroke.bin + BINS - 1) % BINS]];
    let crowded = 0;
    for (const p of stroke.pixels) if (beside[0][p] || beside[1][p] || beside[2][p]) crowded++;
    if (crowded * 2 < stroke.pixels.length) {
      stamp(stroke);
      continue;
    }
    dropped++;
    for (const p of stroke.pixels) gone[p] = 1;
  }

  // Specks: the ends and crossings a removed stroke leaves behind.
  const cut = roundDilate(gone, w, h, 1);
  const rest = new Uint8Array(size);
  for (let i = 0; i < size; i++) rest[i] = ink[i] && !gone[i] ? 1 : 0;
  const visited = new Uint8Array(size);
  for (let start = 0; start < size; start++) {
    if (!rest[start] || visited[start] || !cut[start]) continue;
    const piece: number[] = [];
    const stack = [start];
    visited[start] = 1;
    while (stack.length && piece.length <= SPECK_PX) {
      const p = stack.pop() as number;
      piece.push(p);
      const x = p % w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w, x > 0 ? p - w - 1 : -1, x < w - 1 ? p - w + 1 : -1, x > 0 ? p + w - 1 : -1, x < w - 1 ? p + w + 1 : -1]) {
        if (q < 0 || q >= size || visited[q] || !rest[q]) continue;
        visited[q] = 1;
        stack.push(q);
      }
    }
    if (!stack.length && piece.length <= SPECK_PX) for (const p of piece) gone[p] = 1;
  }

  // Take the strokes out with the soft edge round them: anything no longer
  // beside kept ink goes clear.
  const kept = new Uint8Array(size);
  for (let i = 0; i < size; i++) kept[i] = ink[i] && !gone[i] ? 1 : 0;
  const besideKept = roundDilate(kept, w, h, 1);
  const cleared = roundDilate(gone, w, h, 1);
  for (let i = 0; i < size; i++) if (cleared[i] && !besideKept[i]) data[i * channels + 3] = 0;
  console.info(`[export] hatching thinned: ${dropped} of ${strokes.filter((stroke) => stroke.thinned).length} strokes left out, none closer than ${spacing} px`);
  return sharp(data, { raw: { width: w, height: h, channels } }).png().toBuffer();
}
