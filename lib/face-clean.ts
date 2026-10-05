/**
 * Face shading taken out of the artwork for the production files only.
 *
 * The drawing shades faces with fine parallel hatching. On screen and in the
 * product photo that reads as soft shadow, and it stays there untouched. In
 * the workshop's engraving software the same hatching fills in: the strokes
 * are too fine and too close for the laser, and a cheek comes out as a dark
 * patch. So when the production files are made — and only then — the
 * hatching on the skin of each face is removed, leaving the outlines, the
 * eyes, the eyebrows, the mouth and any beard or moustache.
 *
 * Where the faces are is asked of a text model, which looks and never draws
 * (a fraction of a rupee): the outline of each face's bare skin, and boxes
 * round its eyes, eyebrows and mouth. Its outlines are rough and vary from
 * one answer to the next — one left a forehead out, and a beard came back
 * once as a box over the whole lower face and once as a thin strip — so the
 * model only says roughly WHERE to look. What goes is decided on pixels.
 * Inside the skin, a stroke is removed if it is THIN (outlines and features
 * are drawn several times heavier than hatching), unless
 *   - it grows out of a solid dark mass: a beard, a moustache, an eyebrow
 *     and the hair are solid black with strokes at their edges, and those
 *     strokes are the beard; or
 *   - it is one long line on its own: the side of a nose, not shading.
 */

import sharp from 'sharp';
import { Type } from '@google/genai';
import { roundDilate, roundErode } from './distance-transform';
import { fillPolygon } from './frame-cut';
import { generateJsonFromImage } from './gemini';

if (typeof window !== 'undefined') {
  throw new Error('lib/face-clean.ts was imported into a browser bundle. This module is server-only.');
}

const FACES_PROMPT = `This is a black pen-and-ink portrait drawing. Everything below is on a 0-1000 scale (y down, x right).
Return "faces": one entry for EVERY person's face, each with:
- "skin": 14 to 24 points [y, x], in order round the outline of the BARE SKIN of the face: along the hairline across the forehead, down the side of the face in front of the ear, along the edge of the jaw and chin, and back up the other side. Hair, ears and the neck are OUTSIDE it. A beard is inside it.
- "eyes": one box [ymin, xmin, ymax, xmax] round each eye, lashes and lids included.
- "brows": one box round each eyebrow, the whole of it.
- "mouth": one box round the lips.
- "nose": one box round the nose, from between the eyes down to the bottom of the nostrils and as wide as the nostrils.
- "hair_on_face": one outline for each area of facial hair — a moustache, a beard, stubble, sideburns — as 10 to 24 points [y, x] in order round the EDGE of the hair itself, following where the beard stops on the cheeks and under the lip, so that bare cheek is outside it; or an empty list for a clean-shaven face.
- "marks": one box round each mark on the skin that belongs to the person — a bindi or pottu, kumkum, a mole — or an empty list.`;

const BOXES = { type: Type.ARRAY, items: { type: Type.ARRAY, items: { type: Type.NUMBER } } };
const FACES_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    faces: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          skin: BOXES,
          eyes: BOXES,
          brows: BOXES,
          mouth: { type: Type.ARRAY, items: { type: Type.NUMBER } },
          nose: { type: Type.ARRAY, items: { type: Type.NUMBER } },
          hair_on_face: { type: Type.ARRAY, items: BOXES },
          marks: BOXES,
        },
        required: ['skin', 'eyes', 'brows', 'mouth', 'nose', 'hair_on_face', 'marks'],
      },
    },
  },
  required: ['faces'],
};

interface Point {
  x: number;
  y: number;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface FaceMap {
  /** Outline of the bare skin, in fractions of the drawing. */
  skin: Point[];
  /** Eyes, brows, mouth, the base of the nose and marks: left exactly as drawn. */
  keep: Box[];
  /** Outlines of beards and moustaches: left exactly as drawn. */
  hair: Point[][];
}

function toBox(value: unknown): Box | null {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  const [top, left, bottom, right] = (value as number[]).map((n) => n / 1000);
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

function toOutline(value: unknown): Point[] {
  return (Array.isArray(value) ? value : [])
    .filter((p): p is number[] => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n)))
    .map(([y, x]) => ({ x: x / 1000, y: y / 1000 }));
}

/** How much of the nose's box, from the bottom up, is left as drawn. */
const NOSE_KEPT = 0.45;

/** The faces in `drawing` (an opaque PNG), or none if they could not be read. */
export async function findFaceMaps(drawing: Buffer): Promise<FaceMap[]> {
  const answer = (await generateJsonFromImage({ prompt: FACES_PROMPT, image: { bytes: drawing, mimeType: 'image/png' }, schema: FACES_SCHEMA })) as {
    faces?: { skin?: unknown; eyes?: unknown; brows?: unknown; mouth?: unknown; nose?: unknown; hair_on_face?: unknown; marks?: unknown }[];
  } | null;
  const maps: FaceMap[] = [];
  for (const face of Array.isArray(answer?.faces) ? answer.faces : []) {
    const skin = toOutline(face.skin);
    if (skin.length < 6) continue;
    const boxes = [face.eyes, face.brows, face.marks].flatMap((list) => (Array.isArray(list) ? list : [])).concat([face.mouth]);
    const hair = (Array.isArray(face.hair_on_face) ? face.hair_on_face : []).map(toOutline).filter((outline) => outline.length >= 3);
    const keep = boxes.map(toBox).filter((b): b is Box => b !== null);
    // Of the nose, only the nostrils and wings: that is where its outline
    // is, drawn as thin as hatching (a boy's went with his cheek shading).
    // The bridge above carries shading, and is cleaned like the cheeks.
    const nose = toBox(face.nose);
    if (nose) keep.push({ ...nose, top: nose.bottom - (nose.bottom - nose.top) * NOSE_KEPT });
    maps.push({ skin, keep, hair });
  }
  return maps;
}

/** Alpha at or above this is ink. */
const INK_ALPHA = 96;
/** The skin outline is pulled in by this fraction of the face's width, to stay off the hairline. */
const SKIN_INSET = 0.02;
/** Boxes round eyes, brows and mouth are grown by this fraction of their size. */
const KEEP_GROW = 0.12;
/** A stroke whose half-width is under this fraction of the face's width is thin: hatching. Outlines survive. */
const THIN_RADIUS = 0.0065;
/** Ink at least this fraction of the face's width in half-width is a solid mass: beard, moustache, brow, hair. */
const MASS_RADIUS = 0.013;
/** Thin strokes are kept this far out from a solid mass, measured along the ink, as a fraction of the face's width. */
const MASS_REACH = 0.045;
/** A thin stroke at least this long (fraction of the face's width) and no fatter than a single line is an outline, and stays. */
const LINE_LENGTH = 0.2;

/**
 * `sketch` (the transparent master artwork) with the hatching taken off the
 * skin of every face. Returns the sketch untouched if no face is found or
 * the lookup fails: a production file with shading in it is better than no
 * production file.
 */
export async function cleanFaceShading(sketch: Buffer): Promise<Buffer> {
  const flat = await sharp(sketch).flatten({ background: '#ffffff' }).png().toBuffer();
  // Asked twice, and both answers used: a face or a forehead left out of
  // one is usually in the other.
  const asks = await Promise.allSettled([findFaceMaps(flat), findFaceMaps(flat)]);
  const faces = asks.flatMap((ask) => (ask.status === 'fulfilled' ? ask.value : []));
  if (!faces.length) {
    console.info('[export] no faces found in the artwork; shading left as drawn');
    return sketch;
  }

  const { data, info } = await sharp(sketch).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let removed = 0;
  for (const face of faces) removed += cleanOneFace(data, width, height, channels, face);
  console.info(`[export] face shading removed from ${faces.length} face outlines (${removed} px of ink)`);
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

/** Removes the hatching inside one face's skin, in place; returns how many ink pixels went. */
function cleanOneFace(data: Buffer, width: number, height: number, channels: number, face: FaceMap): number {
  const xs = face.skin.map((p) => p.x * width);
  const ys = face.skin.map((p) => p.y * height);
  const faceWidth = Math.max(...xs) - Math.min(...xs);
  if (faceWidth < 24) return 0;
  const pad = Math.round(faceWidth * 0.1);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)) - pad);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)) - pad);
  const w = Math.min(width, Math.ceil(Math.max(...xs)) + pad) - x0;
  const h = Math.min(height, Math.ceil(Math.max(...ys)) + pad) - y0;
  if (w < 8 || h < 8) return 0;

  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) ink[y * w + x] = data[((y + y0) * width + x + x0) * channels + 3] >= INK_ALPHA ? 1 : 0;
  }

  // Where shading may be removed: the skin, pulled in off the hairline,
  // less the eyes, brows, mouth and marks.
  const skin = new Uint8Array(w * h);
  fillPolygon(skin, w, h, face.skin.map((p) => ({ x: p.x * width - x0, y: p.y * height - y0 })));
  const region = roundErode(skin, w, h, Math.max(1, Math.round(faceWidth * SKIN_INSET)));
  for (const box of face.keep) {
    const gx = (box.right - box.left) * KEEP_GROW * width;
    const gy = (box.bottom - box.top) * KEEP_GROW * height;
    const left = Math.max(0, Math.floor(box.left * width - gx - x0));
    const right = Math.min(w - 1, Math.ceil(box.right * width + gx - x0));
    const top = Math.max(0, Math.floor(box.top * height - gy - y0));
    const bottom = Math.min(h - 1, Math.ceil(box.bottom * height + gy - y0));
    for (let y = top; y <= bottom; y++) if (right >= left) region.fill(0, y * w + left, y * w + right + 1);
  }

  const open = (radius: number) => {
    const opened = roundDilate(roundErode(ink, w, h, radius), w, h, radius);
    for (let i = 0; i < opened.length; i++) opened[i] = opened[i] && ink[i] ? 1 : 0;
    return opened;
  };
  const thick = open(Math.max(2, Math.round(faceWidth * THIN_RADIUS)));
  const mass = open(Math.max(3, Math.round(faceWidth * MASS_RADIUS)));

  // Strokes growing out of a solid mass, followed along the ink.
  const reach = Math.round(faceWidth * MASS_REACH);
  const distance = new Int32Array(w * h).fill(-1);
  let frontier: number[] = [];
  for (let i = 0; i < mass.length; i++) {
    if (!mass[i]) continue;
    distance[i] = 0;
    frontier.push(i);
  }
  for (let d = 1; d <= reach && frontier.length; d++) {
    const next: number[] = [];
    for (const p of frontier) {
      const x = p % w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
        if (q < 0 || q >= ink.length || !ink[q] || distance[q] >= 0) continue;
        distance[q] = d;
        next.push(q);
      }
    }
    frontier = next;
  }

  // What is left is thin and away from any mass: hatching, or a lone line.
  const loose = new Uint8Array(w * h);
  for (let i = 0; i < loose.length; i++) loose[i] = ink[i] && !thick[i] && distance[i] < 0 ? 1 : 0;
  const gone = new Uint8Array(w * h);
  const seen = new Uint8Array(w * h);
  const lineWidth = 2 * Math.max(2, Math.round(faceWidth * THIN_RADIUS)) + 1;
  for (let start = 0; start < loose.length; start++) {
    if (!loose[start] || seen[start]) continue;
    const piece: number[] = [];
    const stack = [start];
    seen[start] = 1;
    let left = w, right = 0, top = h, bottom = 0;
    while (stack.length) {
      const p = stack.pop() as number;
      piece.push(p);
      const x = p % w;
      const y = (p - x) / w;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w, p - w - 1, p - w + 1, p + w - 1, p + w + 1]) {
        if (q < 0 || q >= loose.length || seen[q] || !loose[q]) continue;
        seen[q] = 1;
        stack.push(q);
      }
    }
    const length = Math.hypot(right - left + 1, bottom - top + 1);
    const lone = length >= faceWidth * LINE_LENGTH && piece.length <= length * lineWidth * 1.6;
    if (lone) continue;
    for (const p of piece) if (region[p]) gone[p] = 1;
  }

  // Take the strokes out, with the soft edge round them: anything in the
  // skin that is no longer beside kept ink goes clear.
  const kept = new Uint8Array(w * h);
  for (let i = 0; i < kept.length; i++) kept[i] = ink[i] && !gone[i] ? 1 : 0;
  const beside = roundDilate(kept, w, h, 1);
  let count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!region[i] || beside[i]) continue;
      const a = ((y + y0) * width + x + x0) * channels + 3;
      if (data[a] >= INK_ALPHA) count++;
      data[a] = 0;
    }
  }
  return count;
}
