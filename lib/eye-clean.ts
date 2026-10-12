/**
 * The shading round the eyes taken out, for the production files only.
 *
 * The drawing sets an eye in shadow: short strokes under the eyebrow, a
 * dark patch at the inner corner, lashes, creases. They are drawn so close
 * that they touch, and in the workshop's engraving software — which shows a
 * file hard-edged — eyebrow, shadow and eye run together into one black
 * patch. Neither lib/face-clean.ts nor lib/hatch-thin.ts can help: both look
 * for separate fine strokes, and here there are none left to find.
 *
 * So round each eye the test is turned about. Not "what is shading, to take
 * out" but "what is the eye, to keep", and an eye is two kinds of ink:
 *
 *   - a solid mass: the iris, the eyebrow;
 *   - a line, long and no thicker than a line, that runs the way the eye
 *     does: a lid, a crease.
 *
 * Everything else on the skin in a box round the eye goes: shading strokes are short
 * and run at a slant, and where they have run together the patch they make
 * is neither solid nor a line. A dot or a
 * ring standing on its own is a mark (a bindi sits between the eyebrows)
 * and stays whatever its size.
 *
 * Arithmetic on pixels; no model is asked anything. The faces come from the
 * look lib/face-clean.ts has already paid for.
 */

import sharp from 'sharp';
import { roundDilate, roundErode } from './distance-transform';
import { fillPolygon } from './frame-cut';
import type { FaceMap } from './face-clean';

if (typeof window !== 'undefined') {
  throw new Error('lib/eye-clean.ts was imported into a browser bundle. This module is server-only.');
}

/** Alpha at or above this is ink. */
const INK_ALPHA = 96;
/** Only on a face at least this many pixels wide (lib/face-clean.ts draws the same line); on a smaller one an eye is a few fine lines, and all of it stays. */
const EYE_FACE_PX = 285;
/** The box reaches this fraction of the face's width beyond the eye's own, towards the nose and downwards... */
const MARGIN = 0.06;
/** ...and this far towards the ear, where the hair is. */
const MARGIN_OUT = 0.01;
/**
 * A solid mass is ink that a disc of this radius fits inside: 13 px across,
 * half an iris on the smallest face this is done to. In pixels, and small:
 * the faces come from a model and are rough, and with this taken from an
 * eye's box, and then from a face's outline, an eye boxed too wide and a
 * face outlined too wide each lost an iris. Too small only keeps more.
 */
const MASS_PX = 6;
/** A line is ink that runs straight for this fraction of the face's width or more (a third of an eye), held between two lengths in pixels for the same reason... */
const LINE = 0.09;
const LINE_MIN_PX = 20;
const LINE_MAX_PX = 36;
/** An eye's box narrower or wider than these fractions of the face's width is a misreading, and that eye is left alone. */
const EYE_NARROWEST = 0.12;
const EYE_WIDEST = 0.45;
/** ...within this angle of the line through both eyes, and no thicker than a solid mass is tall. */
const SWING = (40 * Math.PI) / 180;
const SWING_STEP = (5 * Math.PI) / 180;
/** A piece of ink on its own, no more than this many times longer one way than the other and filling this share of its box (or closed round a hole), is a mark. */
const MARK_ASPECT = 2.2;
const MARK_FILL = 0.5;
/** A ring has at least this many pixels of paper closed inside it. */
const RING_HOLE_PX = 4;

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** `sketch` (the transparent master artwork) with the shading round the eyes of `faces` taken out. */
export async function clearRoundEyes(sketch: Buffer, faces: FaceMap[]): Promise<Buffer> {
  const { data, info } = await sharp(sketch).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels } = info;
  let removed = 0;
  let eyes = 0;
  // Where it has been done: each face comes twice, once from each answer, and an eye is done once.
  const done = new Uint8Array(w * h);
  // Every eyebrow, mark, mouth and pair of spectacles either answer found: nothing inside their boxes is touched.
  const off = faces.flatMap((face) => [...face.brows, ...face.solid]);

  for (const face of faces) {
    const outline = face.agreed ? [...face.skin, ...face.agreed] : face.skin;
    const xs = outline.map((p) => p.x * w);
    const faceWidth = Math.max(...xs) - Math.min(...xs);
    if (faceWidth < EYE_FACE_PX) continue;
    const centre = (box: Box) => ({ x: ((box.left + box.right) / 2) * w, y: ((box.top + box.bottom) / 2) * h });
    const inside = (box: Box, p: { x: number; y: number }) => p.x >= box.left * w && p.x <= box.right * w && p.y >= box.top * h && p.y <= box.bottom * h;
    // Spectacles: a box that is not an eye's, round an eye. Their frames are lines at every angle, and are left alone.
    if (face.solid.some((box) => face.eyes.some((eye) => inside(box, centre(eye))))) continue;
    // The way the eyes run: along the line from one to the other.
    const ends = face.eyes.map(centre).sort((a, b) => a.x - b.x);
    const roll = ends.length >= 2 ? Math.atan2(ends[ends.length - 1].y - ends[0].y, ends[ends.length - 1].x - ends[0].x) : 0;
    const margin = faceWidth * MARGIN;
    const mass = MASS_PX;
    const line = Math.min(LINE_MAX_PX, Math.max(LINE_MIN_PX, Math.round(faceWidth * LINE)));
    // A line may be as thick as the smallest mass, and a little over: nothing falls between the two.
    const thickest = mass * 2 + 3;

    for (const eye of face.eyes) {
      const eyeWidth = (eye.right - eye.left) * w;
      if (eyeWidth < faceWidth * EYE_NARROWEST || eyeWidth > faceWidth * EYE_WIDEST) continue;
      const middle = centre(eye);
      if (done[Math.min(h - 1, Math.max(0, Math.round(middle.y))) * w + Math.min(w - 1, Math.max(0, Math.round(middle.x)))]) continue;
      // The box, with room round it for what is measured at its edges.
      const pad = line + mass + 2;
      const x0 = Math.max(0, Math.floor(eye.left * w - margin - pad));
      const y0 = Math.max(0, Math.floor(Math.min(eye.top, ...face.brows.map((brow) => brow.top)) * h - margin - pad));
      const bw = Math.min(w, Math.ceil(eye.right * w + margin + pad)) - x0;
      const bh = Math.min(h, Math.ceil(eye.bottom * h + margin + pad)) - y0;
      if (bw < 8 || bh < 8) continue;
      const ink = new Uint8Array(bw * bh);
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) ink[y * bw + x] = data[((y + y0) * w + x + x0) * channels + 3] >= INK_ALPHA ? 1 : 0;

      // Solid masses: what a disc fits inside, and a pixel more to take in the edge.
      const solid = roundDilate(roundErode(ink, bw, bh, mass), bw, bh, mass + 1);
      // Up to the eyebrow above the eye; what is inside an eyebrow's own box is never touched (below).
      let top = eye.top * h - margin;
      for (const brow of face.brows) if (brow.right >= eye.left && brow.left <= eye.right && brow.top <= eye.top) top = Math.min(top, brow.top * h);
      // Towards the ear the box stops short: the hair is there.
      const outer = faceWidth * MARGIN_OUT;
      const onLeft = (eye.left + eye.right) / 2 < (Math.min(...xs) + Math.max(...xs)) / 2 / w;
      const zone = {
        left: Math.max(0, Math.floor(eye.left * w - (onLeft ? outer : margin) - x0)),
        right: Math.min(bw - 1, Math.ceil(eye.right * w + (onLeft ? margin : outer) - x0)),
        top: Math.max(0, Math.floor(top - y0)),
        bottom: Math.min(bh - 1, Math.ceil(eye.bottom * h + margin - y0)),
      };

      // Lines: ink on a straight run of ink at least `line` long, the way the
      // eyes run, and no more than `thickest` through the other way.
      const lined = new Uint8Array(bw * bh);
      const ways: number[][] = [];
      for (let a = roll - SWING; a <= roll + SWING + 1e-6; a += SWING_STEP) ways.push([Math.cos(a), Math.sin(a)]);
      const on = (x: number, y: number) => x >= 0 && y >= 0 && x < bw && y < bh && ink[y * bw + x] === 1;
      for (let y = zone.top; y <= zone.bottom; y++) {
        for (let x = zone.left; x <= zone.right; x++) {
          if (!ink[y * bw + x] || solid[y * bw + x]) continue;
          for (const [dx, dy] of ways) {
            let run = 1;
            for (let t = 1; run < line && on(Math.round(x + dx * t), Math.round(y + dy * t)); t++) run++;
            for (let t = 1; run < line && on(Math.round(x - dx * t), Math.round(y - dy * t)); t++) run++;
            if (run < line) continue;
            let thick = 1;
            for (let t = 1; thick <= thickest && on(Math.round(x - dy * t), Math.round(y + dx * t)); t++) thick++;
            for (let t = 1; thick <= thickest && on(Math.round(x + dy * t), Math.round(y - dx * t)); t++) thick++;
            if (thick <= thickest) {
              lined[y * bw + x] = 1;
              break;
            }
          }
        }
      }
      const lines = roundDilate(lined, bw, bh, 1);

      // Marks: a compact piece of ink standing on its own, or a ring.
      const marks = new Uint8Array(bw * bh);
      const seen = new Uint8Array(bw * bh);
      for (let start = 0; start < ink.length; start++) {
        if (!ink[start] || seen[start]) continue;
        const piece: number[] = [];
        const stack = [start];
        seen[start] = 1;
        let l = bw, r = 0, t = bh, b = 0;
        while (stack.length) {
          const p = stack.pop() as number;
          piece.push(p);
          const x = p % bw;
          const y = (p - x) / bw;
          if (x < l) l = x;
          if (x > r) r = x;
          if (y < t) t = y;
          if (y > b) b = y;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const qx = x + dx;
              const qy = y + dy;
              if (qx < 0 || qy < 0 || qx >= bw || qy >= bh) continue;
              const q = qy * bw + qx;
              if (seen[q] || !ink[q]) continue;
              seen[q] = 1;
              stack.push(q);
            }
          }
        }
        const pw = r - l + 1;
        const ph = b - t + 1;
        if (l === 0 || t === 0 || r === bw - 1 || b === bh - 1 || Math.max(pw, ph) > Math.min(pw, ph) * MARK_ASPECT || Math.min(pw, ph) < 4) continue;
        // A ring: its box has paper inside that cannot be reached from the
        // box's edge — as drawn, or grown a pixel (a ring drawn with a break
        // in it is still a ring).
        const holes = (grow: number) => {
          const own = new Uint8Array(pw * ph);
          for (const p of piece) {
            const px = (p % bw) - l;
            const py = Math.floor(p / bw) - t;
            for (let dy = -grow; dy <= grow; dy++) for (let dx = -grow; dx <= grow; dx++) if (px + dx >= 0 && px + dx < pw && py + dy >= 0 && py + dy < ph) own[(py + dy) * pw + px + dx] = 1;
          }
          const reached = new Uint8Array(pw * ph);
          const edge: number[] = [];
          for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) if ((x === 0 || y === 0 || x === pw - 1 || y === ph - 1) && !own[y * pw + x]) edge.push(y * pw + x);
          for (const p of edge) reached[p] = 1;
          while (edge.length) {
            const p = edge.pop() as number;
            const x = p % pw;
            for (const q of [x > 0 ? p - 1 : -1, x < pw - 1 ? p + 1 : -1, p - pw, p + pw]) {
              if (q < 0 || q >= own.length || own[q] || reached[q]) continue;
              reached[q] = 1;
              edge.push(q);
            }
          }
          let hole = 0;
          for (let i = 0; i < own.length; i++) if (!own[i] && !reached[i]) hole++;
          return hole;
        };
        const ring = piece.length < pw * ph * MARK_FILL && (holes(0) >= RING_HOLE_PX || holes(1) >= RING_HOLE_PX);
        if (ring || piece.length >= pw * ph * MARK_FILL) for (const p of piece) marks[p] = 1;
      }

      // What is none of those goes, on the skin (the hair at a temple is
      // outside it) and outside the boxes that are never touched.
      const skin = new Uint8Array(bw * bh);
      fillPolygon(skin, bw, bh, face.skin.map((p) => ({ x: p.x * w - x0, y: p.y * h - y0 })));
      const kept = new Uint8Array(bw * bh);
      const gone = new Uint8Array(bw * bh);
      for (let i = 0; i < kept.length; i++) kept[i] = ink[i];
      for (let y = zone.top; y <= zone.bottom; y++) {
        for (let x = zone.left; x <= zone.right; x++) {
          const i = y * bw + x;
          if (!ink[i] || !skin[i] || solid[i] || lines[i] || marks[i]) continue;
          if (off.some((box) => inside(box, { x: x + x0, y: y + y0 }))) continue;
          gone[i] = 1;
          kept[i] = 0;
        }
      }
      for (let y = zone.top; y <= zone.bottom; y++) done.fill(1, (y + y0) * w + zone.left + x0, (y + y0) * w + zone.right + x0 + 1);
      // Taken out with the soft edge round it: whatever is no longer beside kept ink goes clear.
      const besideKept = roundDilate(kept, bw, bh, 1);
      const cleared = roundDilate(gone, bw, bh, 1);
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const i = y * bw + x;
          if (!cleared[i] || besideKept[i]) continue;
          const a = ((y + y0) * w + x + x0) * channels + 3;
          if (data[a] >= INK_ALPHA) removed++;
          data[a] = 0;
        }
      }
      eyes++;
    }
  }
  console.info(`[export] shading cleared round ${eyes} eyes (${removed} px of ink)`);
  return sharp(data, { raw: { width: w, height: h, channels } }).png().toBuffer();
}
