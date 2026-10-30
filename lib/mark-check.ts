/**
 * Dots on a face checked against the photo, after the drawing comes back.
 *
 * However the prompt is worded, the inker now and then adds a mole that is
 * not there (three on a man with clear skin, 31 Oct) or draws a pottu
 * several times its size. So each small round dot drawn on a face is looked
 * up in the photo, at the same place:
 *
 *   - plain skin there: the dot was made up, and is taken out;
 *   - a real mark there (darker, paler or redder than the skin round it),
 *     but the dot drawn much bigger than it: the dot is redrawn as a solid
 *     dot of the mark's own size, measured in the photo.
 *
 * Real features stand out from the skin in the photo — a pupil, a nostril,
 * a nose stud, a real mole — so they are kept as drawn. Arithmetic on
 * pixels; no model is asked anything.
 */

import sharp from 'sharp';
import type { Region } from './ink-filter';

if (typeof window !== 'undefined') {
  throw new Error('lib/mark-check.ts was imported into a browser bundle. This module is server-only.');
}

/** Darker than this (0-255) is ink. */
const INK = 110;
/** A dot is at least this many pixels... */
const MIN_DOT_PX = 6;
/** ...and at most this share of its face box's side across. */
const MAX_DOT_SHARE = 0.09;
/** A dot's box is no longer than this many times its width. */
const MAX_ASPECT = 1.8;
/** A filled dot covers at least this share of its box (a disc covers 0.79); a ring counts once its hole is filled. */
const MIN_FILL = 0.55;
/** A photo pixel this far (RGB distance) from the skin round it is part of a mark. */
const MARK_COLOUR = 34;
/** Fewer marked photo pixels than this share of the drawn dot: plain skin, the dot was made up. */
const MADE_UP = 0.12;
/**
 * How far beyond a dot its mark is looked for in the photo, in pixels: the
 * close-ups line up to within about 7. Wider, and an eye or the hairline
 * beside a made-up mole was taken for the mark (31 Oct).
 */
const SLACK_PX = 6;
/** A dot drawn more than this many times the area of its mark in the photo is shrunk to it. */
const TOO_BIG = 2.2;

interface Dot {
  pixels: number[];
  cx: number;
  cy: number;
  /** Area with any hole filled, in pixels. */
  area: number;
  radius: number;
}

/** Small, round, separate pieces of ink inside a box: dots and rings. */
function dotsIn(ink: Uint8Array, width: number, box: { left: number; top: number; right: number; bottom: number }, maxSide: number): Dot[] {
  const seen = new Uint8Array(ink.length);
  const dots: Dot[] = [];
  for (let y = box.top; y < box.bottom; y++) {
    for (let x = box.left; x < box.right; x++) {
      const start = y * width + x;
      if (!ink[start] || seen[start]) continue;
      const pixels: number[] = [];
      const stack = [start];
      seen[start] = 1;
      let l = x, r = x, t = y, b = y;
      let tooBig = false;
      while (stack.length) {
        const p = stack.pop() as number;
        pixels.push(p);
        const px = p % width;
        const py = (p - px) / width;
        if (px < l) l = px;
        if (px > r) r = px;
        if (py < t) t = py;
        if (py > b) b = py;
        if (r - l > maxSide || b - t > maxSide) tooBig = true;
        for (const q of [p - 1, p + 1, p - width, p + width, p - width - 1, p - width + 1, p + width - 1, p + width + 1]) {
          const qx = q % width;
          if (q < 0 || q >= ink.length || Math.abs(qx - px) > 1 || seen[q] || !ink[q]) continue;
          seen[q] = 1;
          stack.push(q);
        }
      }
      const w = r - l + 1;
      const h = b - t + 1;
      if (tooBig || pixels.length < MIN_DOT_PX || Math.max(w, h) > Math.min(w, h) * MAX_ASPECT) continue;
      // The box less the paper reachable from its edge: the dot with any hole filled.
      const own = new Uint8Array(w * h);
      for (const p of pixels) own[(Math.floor(p / width) - t) * w + (p % width) - l] = 1;
      const outside = new Uint8Array(w * h);
      const edge: number[] = [];
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) if ((xx === 0 || yy === 0 || xx === w - 1 || yy === h - 1) && !own[yy * w + xx]) edge.push(yy * w + xx);
      for (const p of edge) outside[p] = 1;
      while (edge.length) {
        const p = edge.pop() as number;
        const px = p % w;
        for (const q of [px > 0 ? p - 1 : -1, px < w - 1 ? p + 1 : -1, p - w, p + w]) {
          if (q < 0 || q >= own.length || own[q] || outside[q]) continue;
          outside[q] = 1;
          edge.push(q);
        }
      }
      const filled: number[] = [];
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) if (!outside[yy * w + xx]) filled.push((t + yy) * width + l + xx);
      if (filled.length < w * h * MIN_FILL) continue;
      dots.push({ pixels: filled, cx: (l + r) / 2, cy: (t + b) / 2, area: filled.length, radius: Math.max(w, h) / 2 });
    }
  }
  return dots;
}

/**
 * How many photo pixels near the dot stand out from the skin round it: the
 * size of the real mark there, in drawing pixels. The skin is the median of
 * a ring well outside the dot; the mark is searched for a little beyond the
 * dot, since the drawing and the photo line up only to a few pixels: when
 * in doubt the dot is kept.
 */
function markArea(photo: Buffer, width: number, height: number, dot: Dot, slack: number): number {
  const inner = dot.radius * 1.6 + 3 + slack;
  const ringIn = inner + dot.radius + 2;
  const ringOut = ringIn + dot.radius + 4;
  const skin: number[][] = [[], [], []];
  const near: number[] = [];
  for (let y = Math.floor(dot.cy - ringOut); y <= dot.cy + ringOut; y++) {
    for (let x = Math.floor(dot.cx - ringOut); x <= dot.cx + ringOut; x++) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const d = Math.hypot(x - dot.cx, y - dot.cy);
      const i = (y * width + x) * 3;
      if (d >= ringIn && d <= ringOut) for (let c = 0; c < 3; c++) skin[c].push(photo[i + c]);
      else if (d <= inner) near.push(i);
    }
  }
  if (skin[0].length < 8) return Infinity;
  const median = skin.map((values) => values.sort((a, b) => a - b)[values.length >> 1]);
  let marked = 0;
  for (const i of near) if (Math.hypot(photo[i] - median[0], photo[i + 1] - median[1], photo[i + 2] - median[2]) > MARK_COLOUR) marked++;
  return marked;
}

/** The drawing with made-up dots on the faces taken out and oversized ones brought to their real size. */
export async function checkMarks(drawing: Buffer, photo: Buffer, faces: Region[]): Promise<Buffer> {
  const { data, info } = await sharp(drawing).flatten({ background: '#ffffff' }).greyscale().extractChannel(0).raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const colour = await sharp(photo).flatten({ background: '#ffffff' }).removeAlpha().resize(width, height, { fit: 'fill' }).blur(1).raw().toBuffer();
  const out = Buffer.from(data);
  const ink = new Uint8Array(width * height);
  for (let i = 0; i < ink.length; i++) ink[i] = data[i] < INK ? 1 : 0;
  let removed = 0;
  let shrunk = 0;
  for (const face of faces) {
    const box = {
      left: Math.max(0, Math.floor(face.left * width)),
      top: Math.max(0, Math.floor(face.top * height)),
      right: Math.min(width, Math.ceil(face.right * width)),
      bottom: Math.min(height, Math.ceil(face.bottom * height)),
    };
    const maxSide = Math.max(4, Math.round(Math.min(box.right - box.left, box.bottom - box.top) * MAX_DOT_SHARE));
    for (const dot of dotsIn(ink, width, box, maxSide)) {
      const real = markArea(colour, width, height, dot, SLACK_PX);
      if (real < dot.area * MADE_UP) {
        for (const p of dot.pixels) out[p] = 255;
        removed++;
      } else if (dot.area > real * TOO_BIG) {
        for (const p of dot.pixels) out[p] = 255;
        const r = Math.max(1.5, Math.sqrt(real / Math.PI));
        for (let y = Math.floor(dot.cy - r); y <= dot.cy + r; y++) {
          for (let x = Math.floor(dot.cx - r); x <= dot.cx + r; x++) {
            if (x >= 0 && y >= 0 && x < width && y < height && Math.hypot(x - dot.cx, y - dot.cy) <= r) out[y * width + x] = 0;
          }
        }
        shrunk++;
      }
    }
  }
  if (removed || shrunk) console.info(`[sketch] dots on faces checked against the photo: ${removed} made up and taken out, ${shrunk} drawn too big and shrunk`);
  return sharp(out, { raw: { width, height, channels: 1 } }).png().toBuffer();
}
