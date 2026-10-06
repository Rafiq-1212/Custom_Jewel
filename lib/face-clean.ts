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
 * On the skin, a stroke is removed if it is THIN (outlines and features
 * are drawn several times heavier than hatching), unless
 *   - it grows out of a solid dark mass (a beard, a moustache, a brow);
 *   - it is an eyebrow or a mark, or facial hair: inside the outline the
 *     model drew round a moustache, or anywhere from the nose down on a
 *     face the model says is bearded;
 *   - it hangs off a line of an eye, brow, mouth or nose (lashes, lip
 *     creases), inside that feature's box; or
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
- "facial_hair": exactly one of "none" (clean-shaven), "moustache" (hair on the upper lip only) or "beard" (any hair or stubble on the chin, jaw or cheeks, with or without a moustache).
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
          facial_hair: { type: Type.STRING },
          marks: BOXES,
        },
        required: ['skin', 'eyes', 'brows', 'mouth', 'nose', 'hair_on_face', 'facial_hair', 'marks'],
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
  /** Eyes, mouth and the base of the nose: their own lines are kept, loose shading beside them goes. */
  keep: Box[];
  /** Eyebrows and marks (a bindi, a mole): left exactly as drawn. */
  solid: Box[];
  /** Outlines of beards and moustaches: left exactly as drawn. */
  hair: Point[][];
  /**
   * Set when the face has a beard: everything on the skin from this height
   * down (a fraction of the drawing) is left as drawn. The outlines in
   * `hair` cannot be relied on for a beard — one man's came back covering
   * his chin and not the stubble along his jaw, which was then taken for
   * shading and left as a row of specks.
   */
  beardFrom: number | null;
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
    faces?: { skin?: unknown; eyes?: unknown; brows?: unknown; mouth?: unknown; nose?: unknown; hair_on_face?: unknown; facial_hair?: unknown; marks?: unknown }[];
  } | null;
  const maps: FaceMap[] = [];
  for (const face of Array.isArray(answer?.faces) ? answer.faces : []) {
    const skin = toOutline(face.skin);
    if (skin.length < 6) continue;
    const boxes = (...lists: unknown[]) =>
      lists
        .flatMap((list) => (Array.isArray(list) ? list : []))
        .map(toBox)
        .filter((b): b is Box => b !== null);
    const hair = (Array.isArray(face.hair_on_face) ? face.hair_on_face : []).map(toOutline).filter((outline) => outline.length >= 3);
    const keep = boxes(face.eyes, [face.mouth]);
    // Of the nose, only the nostrils and wings: that is where its outline
    // is, drawn as thin as hatching (a boy's went with his cheek shading).
    // The bridge above carries shading, and is cleaned like the cheeks.
    const nose = toBox(face.nose);
    if (nose) keep.push({ ...nose, top: nose.bottom - (nose.bottom - nose.top) * NOSE_KEPT });
    // A beard is everything from the middle of the nose down.
    const mouth = toBox(face.mouth);
    const beardFrom = face.facial_hair !== 'beard' ? null : nose ? (nose.top + nose.bottom) / 2 : mouth ? mouth.top - (mouth.bottom - mouth.top) : null;
    maps.push({ skin, keep, solid: boxes(face.brows, face.marks), hair, beardFrom });
  }
  return maps;
}

/** Alpha at or above this is ink. */
const INK_ALPHA = 96;
/**
 * The skin outline is pushed OUT by this fraction of the face's width. The
 * model draws it a little inside the face, and the shading that matters most
 * runs along the edge of a cheek, just outside it. Safe because what is
 * removed is decided stroke by stroke (see SKIN_SHARE), not by where a pixel
 * falls: hair that crosses the outline is mostly outside it, and stays.
 */
const SKIN_GROW = 0.04;
/** A group of thin strokes is face shading when at least this share of it lies on the skin. */
const SKIN_SHARE = 0.6;
/** At this share it is removed whole, including what reaches past the outline. */
const WHOLE_SHARE = 0.85;
/** Leftover bits of a removed stroke up to this many pixels (on a face 400 px wide) are removed with it. */
const SPECK_AREA = 60;
/** The beard zone reaches this far past the skin outline, as a fraction of the face's width. */
const BEARD_GROW = 0.06;
/**
 * A stroke is thin — hatching — when it does not survive being opened by
 * this many pixels: under five pixels wide. In pixels, not as a share of the face: measured on a
 * baby's face 780 px wide and on two adults' at 460, the hatching was two
 * pixels wide on all three (four-fifths of all the strokes on the skin),
 * and the outlines six and up. Sized to the face, as it was, the bar on the
 * baby came out at nine pixels and took her jaw line and lips with the
 * shading. The drawing is always made at the same size, so pixels hold.
 */
const THIN_RADIUS_PX = 2;
/** Ink at least this fraction of the face's width in half-width is a solid mass: a beard, a moustache, a brow. */
const MASS_RADIUS = 0.013;
/** Thin strokes are kept this far out from a solid mass, measured along the ink, as a fraction of the face's width. */
const MASS_REACH = 0.03;
/**
 * Inside the boxes round the eyes, brows, mouth and nose, thin strokes are
 * kept this far out from any ordinary line (fraction of the face's width):
 * lashes on a lid, the hairs of a brow, the creases of a lip. Shading that
 * floats free beside them goes.
 */
const FEATURE_REACH = 0.02;
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
  return removeFaceShading(sketch, faces);
}

/** The pixel half of `cleanFaceShading`: the same sketch with the shading inside `faces` removed. */
export async function removeFaceShading(sketch: Buffer, faces: FaceMap[]): Promise<Buffer> {
  const { data, info } = await sharp(sketch).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  // What is never touched, from every answer together: the same face comes
  // back more than once, and a beard seen in one answer protects it in all.
  const protect = new Uint8Array(width * height);
  const scaled = (points: Point[]) => points.map((p) => ({ x: p.x * width, y: p.y * height }));
  for (const face of faces) {
    for (const box of face.solid) {
      const left = Math.max(0, Math.floor(box.left * width));
      const right = Math.min(width - 1, Math.ceil(box.right * width));
      for (let y = Math.max(0, Math.floor(box.top * height)); y <= Math.min(height - 1, Math.ceil(box.bottom * height)); y++) {
        if (right >= left) protect.fill(1, y * width + left, y * width + right + 1);
      }
    }
    for (const outline of face.hair) fillPolygon(protect, width, height, scaled(outline));
    if (face.beardFrom !== null) {
      const skin = new Uint8Array(width * height);
      fillPolygon(skin, width, height, scaled(face.skin));
      const xs = face.skin.map((p) => p.x * width);
      const grown = roundDilate(skin, width, height, Math.round((Math.max(...xs) - Math.min(...xs)) * BEARD_GROW));
      for (let i = Math.max(0, Math.floor(face.beardFrom * height)) * width; i < grown.length; i++) if (grown[i]) protect[i] = 1;
    }
  }

  let removed = 0;
  for (const face of faces) removed += cleanOneFace(data, width, height, channels, face, protect);
  console.info(`[export] face shading removed from ${faces.length} face outlines (${removed} px of ink)`);
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

/** Every ink pixel within `reach` steps of `from`, walking only through ink. */
function reachable(ink: Uint8Array, from: Uint8Array, w: number, reach: number): Uint8Array {
  const seen = from.slice();
  let frontier: number[] = [];
  for (let i = 0; i < seen.length; i++) if (seen[i]) frontier.push(i);
  for (let d = 1; d <= reach && frontier.length; d++) {
    const next: number[] = [];
    for (const p of frontier) {
      const x = p % w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
        if (q < 0 || q >= ink.length || !ink[q] || seen[q]) continue;
        seen[q] = 1;
        next.push(q);
      }
    }
    frontier = next;
  }
  return seen;
}

/** Removes the hatching inside one face's skin, in place; returns how many ink pixels went. */
function cleanOneFace(data: Buffer, width: number, height: number, channels: number, face: FaceMap, protect: Uint8Array): number {
  const xs = face.skin.map((p) => p.x * width);
  const ys = face.skin.map((p) => p.y * height);
  const faceWidth = Math.max(...xs) - Math.min(...xs);
  if (faceWidth < 24) return 0;
  const pad = Math.round(faceWidth * 0.15);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)) - pad);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)) - pad);
  const w = Math.min(width, Math.ceil(Math.max(...xs)) + pad) - x0;
  const h = Math.min(height, Math.ceil(Math.max(...ys)) + pad) - y0;
  if (w < 8 || h < 8) return 0;

  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) ink[y * w + x] = data[((y + y0) * width + x + x0) * channels + 3] >= INK_ALPHA ? 1 : 0;
  }
  const fill = (points: Point[]) => {
    const mask = new Uint8Array(w * h);
    fillPolygon(mask, w, h, points.map((p) => ({ x: p.x * width - x0, y: p.y * height - y0 })));
    return mask;
  };

  // The skin, a little generously; the features on it; and any facial hair.
  const skin = roundDilate(fill(face.skin), w, h, Math.max(1, Math.round(faceWidth * SKIN_GROW)));
  const feature = new Uint8Array(w * h);
  for (const box of face.keep) {
    const left = Math.max(0, Math.floor(box.left * width - x0));
    const right = Math.min(w - 1, Math.ceil(box.right * width - x0));
    const top = Math.max(0, Math.floor(box.top * height - y0));
    const bottom = Math.min(h - 1, Math.ceil(box.bottom * height - y0));
    for (let y = top; y <= bottom; y++) if (right >= left) feature.fill(1, y * w + left, y * w + right + 1);
  }
  const kept0 = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) kept0[y * w + x] = protect[(y + y0) * width + x + x0];
  }

  const open = (radius: number) => {
    const opened = roundDilate(roundErode(ink, w, h, radius), w, h, radius);
    for (let i = 0; i < opened.length; i++) opened[i] = opened[i] && ink[i] ? 1 : 0;
    return opened;
  };
  const thinRadius = THIN_RADIUS_PX;
  const thick = open(thinRadius);
  const mass = open(Math.max(3, Math.round(faceWidth * MASS_RADIUS)));
  // Thin strokes that belong to something: the fringe of a solid mass, and
  // inside a feature's box whatever hangs off one of its lines.
  const nearMass = reachable(ink, mass, w, Math.round(faceWidth * MASS_REACH));
  const nearLine = reachable(ink, thick, w, Math.round(faceWidth * FEATURE_REACH));

  // The thin strokes, in connected groups: single strokes, and meshes of
  // strokes that cross.
  const thin = new Uint8Array(w * h);
  for (let i = 0; i < thin.length; i++) thin[i] = ink[i] && !thick[i] ? 1 : 0;
  const gone = new Uint8Array(w * h);
  const seen = new Uint8Array(w * h);
  const lineWidth = 2 * thinRadius + 1;
  for (let start = 0; start < thin.length; start++) {
    if (!thin[start] || seen[start]) continue;
    const piece: number[] = [];
    const stack = [start];
    seen[start] = 1;
    let left = w, right = 0, top = h, bottom = 0, onSkin = 0;
    while (stack.length) {
      const p = stack.pop() as number;
      piece.push(p);
      if (skin[p]) onSkin++;
      const x = p % w;
      const y = (p - x) / w;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w, p - w - 1, p - w + 1, p + w - 1, p + w + 1]) {
        if (q < 0 || q >= thin.length || seen[q] || !thin[q]) continue;
        seen[q] = 1;
        stack.push(q);
      }
    }
    // Hair, a collar, an ear: mostly off the skin, and none of our business.
    if (onSkin < piece.length * SKIN_SHARE) continue;
    // One long line on its own is an outline: the side of a nose, a crease.
    const length = Math.hypot(right - left + 1, bottom - top + 1);
    if (length >= faceWidth * LINE_LENGTH && piece.length <= length * lineWidth * 1.6) continue;
    // A group that lies wholly on the skin goes whole, so that no stub of
    // it is left sticking out past the edge of the outline.
    const whole = onSkin >= piece.length * WHOLE_SHARE;
    for (const p of piece) {
      if ((!skin[p] && !whole) || kept0[p] || nearMass[p]) continue;
      if (feature[p] && nearLine[p]) continue;
      gone[p] = 1;
    }
  }

  // Specks: what is left of a stroke that was mostly removed. A mole or a
  // bindi is no speck — it was never part of a removed stroke.
  const cut = roundDilate(gone, w, h, 1);
  const speck = Math.round(SPECK_AREA * (faceWidth / 400) ** 2);
  const visited = new Uint8Array(w * h);
  for (let start = 0; start < ink.length; start++) {
    if (!ink[start] || gone[start] || visited[start]) continue;
    const piece: number[] = [];
    const stack = [start];
    visited[start] = 1;
    let touchesCut = false;
    let off = false;
    while (stack.length) {
      const p = stack.pop() as number;
      if (piece.length <= speck) piece.push(p);
      if (cut[p]) touchesCut = true;
      if (!skin[p] || kept0[p]) off = true;
      const x = p % w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w, p - w - 1, p - w + 1, p + w - 1, p + w + 1]) {
        if (q < 0 || q >= ink.length || visited[q] || !ink[q] || gone[q]) continue;
        visited[q] = 1;
        stack.push(q);
      }
    }
    if (touchesCut && !off && piece.length <= speck) for (const p of piece) gone[p] = 1;
  }

  // Take the strokes out, with the soft edge round them: anything on the
  // skin that is no longer beside kept ink goes clear.
  const kept = new Uint8Array(w * h);
  for (let i = 0; i < kept.length; i++) kept[i] = ink[i] && !gone[i] ? 1 : 0;
  const beside = roundDilate(kept, w, h, 1);
  const cleared = roundDilate(gone, w, h, 1);
  let count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!cleared[i] || beside[i]) continue;
      const a = ((y + y0) * width + x + x0) * channels + 3;
      if (data[a] >= INK_ALPHA) count++;
      data[a] = 0;
    }
  }
  return count;
}
