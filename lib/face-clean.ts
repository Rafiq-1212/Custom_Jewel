/**
 * Face shading taken out of the artwork for the production files only.
 *
 * The drawing shades faces with fine parallel hatching. On screen and in the
 * product photo that reads as soft shadow, and it stays there untouched. In
 * the workshop's engraving software the same hatching fills in: the strokes
 * are too fine and too close for the laser, and a cheek in shadow comes out
 * as a dark patch. So when the production files are made — and only then —
 * the hatching on the skin of each face is removed.
 *
 * Where the faces are is asked of a text model, which looks and never draws
 * (a fraction of a rupee). It is asked twice, because its outlines are rough
 * and differ from one answer to the next, and the two answers are used so
 * that a mistake in either errs towards leaving the drawing alone:
 *
 *   - shading is removed only where BOTH answers put skin;
 *   - nothing is touched where EITHER answer put the mouth, spectacles, a
 *     mark or facial hair (or, on smaller faces, an eye or an eyebrow).
 *
 * What goes is then decided on pixels, and it is only ever HATCHING: several
 * fine strokes side by side. A line on its own — a jaw, the side of a nose,
 * a crease, a strand of hair — is never removed, however thin it is. That
 * rule was arrived at the hard way: judged by thinness alone, a baby's whole
 * eyes went, and a small face lost its jaw line, because on a small face the
 * outlines are as fine as the shading.
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
- "mouth": one box round the lips, and the teeth if they show.
- "nose": one box round the nose, from between the eyes down to the bottom of the nostrils and as wide as the nostrils.
- "hair_on_face": one outline for each area of facial hair — a moustache, a beard, stubble, sideburns — as 10 to 24 points [y, x] in order round the EDGE of the hair itself, following where the beard stops on the cheeks and under the lip, so that bare cheek is outside it; or an empty list for a clean-shaven face.
- "facial_hair": exactly one of "none" (clean-shaven), "moustache" (hair on the upper lip only) or "beard" (any hair or stubble on the chin, jaw or cheeks, with or without a moustache).
- "glasses": one box round the whole of the spectacles or sunglasses, frame and both lenses, if the person wears any; otherwise an empty list.
- "marks": one box round each mark on the skin that belongs to the person — a bindi or pottu, kumkum, a mole — or an empty list.`;

const BOXES = { type: Type.ARRAY, items: { type: Type.ARRAY, items: { type: Type.NUMBER } } };
const BOX = { type: Type.ARRAY, items: { type: Type.NUMBER } };
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
          mouth: BOX,
          nose: BOX,
          hair_on_face: { type: Type.ARRAY, items: BOXES },
          facial_hair: { type: Type.STRING },
          glasses: BOXES,
          marks: BOXES,
        },
        required: ['skin', 'eyes', 'brows', 'mouth', 'nose', 'hair_on_face', 'facial_hair', 'glasses', 'marks'],
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

/** One face, in fractions of the drawing. */
export interface FaceMap {
  /** Outline of the bare skin. */
  skin: Point[];
  /** The same face's skin as the other answer drew it; shading goes only where the two agree. */
  agreed?: Point[];
  /** Mouth, spectacles and marks: left exactly as drawn. */
  solid: Box[];
  /** The eyes: left exactly as drawn except on a large face, where only the shading round them goes. */
  eyes: Box[];
  /** The eyebrows: left exactly as drawn on a tiny face; otherwise kept as solid masses with their hairs. */
  brows: Box[];
  /** The nose: only plain shading is removed inside it, never one of its own lines. */
  nose: Box[];
  /** Beards and moustaches: left exactly as drawn. */
  hair: Point[][];
  /** Set when the face has a beard: everything on the skin from this height down is left as drawn. */
  beardFrom: number | null;
  /**
   * Halfway down the nose. Above it the skin outline is taken as drawn; below
   * it, it is grown out to the jaw. Null when the eyes or nose were not
   * found, and then it is not grown anywhere.
   */
  cheekLine: number | null;
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

/** The faces in `drawing` (an opaque PNG), or none if they could not be read. */
export async function findFaceMaps(drawing: Buffer): Promise<FaceMap[]> {
  const answer = (await generateJsonFromImage({ prompt: FACES_PROMPT, image: { bytes: drawing, mimeType: 'image/png' }, schema: FACES_SCHEMA })) as {
    faces?: Record<string, unknown>[];
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
    const eyes = boxes(face.eyes);
    const nose = toBox(face.nose);
    const mouth = toBox(face.mouth);
    const outlines = (Array.isArray(face.hair_on_face) ? face.hair_on_face : []).map(toOutline).filter((o) => o.length >= 3);
    // A beard is everything from the bottom of the nose down. (From the
    // middle of the nose, it kept the shading on a bearded man's cheeks.)
    const beardFrom = face.facial_hair !== 'beard' ? null : nose ? nose.bottom - (nose.bottom - nose.top) * 0.12 : mouth ? mouth.top - (mouth.bottom - mouth.top) : null;
    maps.push({
      skin,
      solid: [...boxes(face.glasses, face.marks), ...(mouth ? [mouth] : [])],
      eyes,
      brows: boxes(face.brows),
      nose: nose ? [nose] : [],
      hair: outlines,
      beardFrom,
      cheekLine: eyes.length && nose ? (Math.max(...eyes.map((e) => e.bottom)) + nose.bottom) / 2 : null,
    });
  }
  return maps;
}

/** Alpha at or above this is ink. */
const INK_ALPHA = 96;
/**
 * A stroke is fine when it does not survive being opened by this many
 * pixels: under five pixels wide. Hatching is always fine; heavier strokes
 * are never touched.
 */
const THIN_RADIUS_PX = 2;
/**
 * How far the skin reaches past the outline the model drew, as fractions of
 * the face's width. Across the lower cheeks the model cuts corners, and the
 * shading that matters most runs along the edge of a round cheek, so from
 * halfway down the nose the skin is grown out a long way — but never across
 * a heavy line, so it stops at the jaw. Higher up it is grown hardly at
 * all: what lies just outside the outline there is the hairline, a fringe,
 * a sideburn, and a short-cropped temple is drawn in strokes as fine as
 * shading. Grown out everywhere, it took a man's temple and a baby's curls.
 */
const SKIN_GROW_BELOW = 0.12;
const SKIN_GROW_ABOVE = 0.05;
/**
 * Wherever heavy strokes sit close together — a head of hair, a beard — is
 * not skin, whatever the outlines say, as fractions of the face's width:
 * heavy strokes up to twice HAIR_GAP apart are joined, and what is then at
 * least twice HAIR_CORE across counts.
 */
const HAIR_GAP = 0.012;
const HAIR_CORE = 0.045;
/** The boxes and outlines that protect features and hair are grown by this fraction of the face's width. */
const PROTECT_GROW = 0.012;
/** The beard zone reaches this far past the skin outline, as a fraction of the face's width. */
const BEARD_GROW = 0.06;
/** Ink at least this fraction of the face's width in half-width is a solid mass, and its fringe reaches this far from it along the ink. */
const MASS_RADIUS = 0.013;
const MASS_REACH = 0.035;
/** A stroke with at least this share of it on the skin is removed whole. */
const WHOLE_SHARE = 0.7;
/**
 * Cross-hatching: a connected group of fine strokes holding at least as much
 * ink as MESH_STROKES strokes of its own length, MESH_HATCHED of it hatching.
 */
const MESH_STROKES = 3;
const MESH_HATCHED = 0.7;
/**
 * Faces come in three sizes, in pixels of width. Under TINY_FACE (a baby, or
 * four people on one pendant) the eyes and eyebrows are protected outright
 * and only straight hatching goes. Under SMALL_FACE the eyes alone are
 * protected: with the eyebrows' boxes protected as well, the shading down a
 * temple, which runs through those boxes, was all kept. From SMALL_FACE up
 * (each face of a couple) nothing but the mouth, spectacles and marks is
 * protected outright, and round an eye the shading goes and its lines stay.
 * SMALL_FACE sits between what was measured: at 298 px a woman's eyes came
 * out clean and whole, at 271 px a baby's eyebrows, drawn as a few fine
 * hairs, were thinned away.
 */
const TINY_FACE = 230;
const SMALL_FACE = 285;
/**
 * Hatching is told from a line on its own by counting strokes: a pixel is in
 * hatching when a straight probe either side of it, in some direction,
 * crosses at least HATCH_STROKES separate fine strokes. The probe is a
 * fraction of the face's width, HATCH_PROBE, held between two sizes in
 * pixels: the drawing's hatching is much the same pitch on every face, but
 * on a small face a wide probe would count the lines of an eye as hatching.
 */
const HATCH_PROBE = 0.055;
const HATCH_PROBE_MIN = 10;
const HATCH_PROBE_MAX = 24;
const HATCH_STROKES = 4;
/**
 * The outermost stroke of a patch has neighbours on one side only. A stroke
 * lying beside hatching is part of it — unless it is long (LONE_LENGTH of the
 * face's width), which is an outline the hatching runs up to: a jaw.
 */
const LONE_LENGTH = 0.35;
/**
 * Shading is drawn in STRAIGHT strokes, or nearly: a stroke counts as one
 * when it strays from its own line by no more than STRAIGHT_BEND of its
 * length (or STRAIGHT_PX pixels, for the shortest). An eyelid, a jaw, a
 * curl, a strand of hair all bend more than that and are never removed,
 * even when they lie side by side like hatching: a baby's curls over her
 * forehead did, and went, before this was asked.
 */
const STRAIGHT_BEND = 0.13;
const STRAIGHT_PX = 2;
/**
 * And in strokes of some length. Anything shorter than this fraction of the
 * face's width (and never less than SHORT_PX pixels) stays: the lines
 * between teeth, a lash, the corner of a nostril.
 */
const SHORT = 0.06;
/** On a large face the same, but shorter still: the hatching round the eyes is itself short. */
const SHORT_BIG = 0.035;
/** The longest a curved stroke may be and still count as shading, as a fraction of the face's width. */
const CURVED_MAX = 0.28;
/**
 * On the nose a curved stroke is shading only when this much of it is in the
 * thick of hatching, and it keeps clear of the bottom NOSE_BASE of the nose:
 * the nose's own lines are fine and curved too, and the nostrils and the
 * line under them are drawn with hatching hung all along them.
 */
const NOSE_HATCHED = 0.85;
const NOSE_BASE = 0.4;
const SHORT_PX = 14;
/** Inside the box of the nose or an eye a stroke this short (fraction of the face's width) always stays: the edge of a nostril, a lash. */
const NOSE_SHORT = 0.05;
/** Leftover bits of a removed stroke up to this many pixels (on a face 400 px wide) are removed with it. */
const SPECK_AREA = 60;

/**
 * `sketch` (the transparent master artwork) with the hatching taken off the
 * skin of every face. Returns the sketch untouched if no face is found or
 * the lookup fails: a production file with shading in it is better than no
 * production file.
 */
export async function cleanFaceShading(sketch: Buffer): Promise<Buffer> {
  const flat = await sharp(sketch).flatten({ background: '#ffffff' }).png().toBuffer();
  const asks = await Promise.allSettled([findFaceMaps(flat), findFaceMaps(flat)]);
  const [first, second] = asks.map((ask) => (ask.status === 'fulfilled' ? ask.value : null));
  // Both answers or nothing: one answer alone has no check on it.
  if (!first || !second) {
    console.info('[export] the faces could not be read twice; shading left as drawn');
    return sketch;
  }
  return removeFaceShading(sketch, agreeFaces(first, second));
}

/** Pairs up the faces of two answers about the same drawing. A face only one of them saw is left out: it is not cleaned. */
export function agreeFaces(first: FaceMap[], second: FaceMap[]): FaceMap[] {
  const centre = (face: FaceMap) => ({
    x: face.skin.reduce((sum, p) => sum + p.x, 0) / face.skin.length,
    y: face.skin.reduce((sum, p) => sum + p.y, 0) / face.skin.length,
  });
  const within = (p: Point, face: FaceMap) =>
    p.x >= Math.min(...face.skin.map((q) => q.x)) &&
    p.x <= Math.max(...face.skin.map((q) => q.x)) &&
    p.y >= Math.min(...face.skin.map((q) => q.y)) &&
    p.y <= Math.max(...face.skin.map((q) => q.y));
  const unused = [...second];
  const merged: FaceMap[] = [];
  for (const face of first) {
    const i = unused.findIndex((other) => within(centre(other), face) && within(centre(face), other));
    if (i < 0) continue;
    const [other] = unused.splice(i, 1);
    const beards = [face.beardFrom, other.beardFrom].filter((v): v is number => v !== null);
    merged.push({
      skin: face.skin,
      agreed: other.skin,
      solid: [...face.solid, ...other.solid],
      eyes: [...face.eyes, ...other.eyes],
      brows: [...face.brows, ...other.brows],
      nose: [...face.nose, ...other.nose],
      hair: [...face.hair, ...other.hair],
      beardFrom: beards.length ? Math.min(...beards) : null,
      // The lower of the two, so that more of the face is treated with care.
      cheekLine: face.cheekLine === null || other.cheekLine === null ? null : Math.max(face.cheekLine, other.cheekLine),
    });
  }
  return merged;
}

/** The pixel half of `cleanFaceShading`: the same sketch with the hatching on the skin of `faces` removed. */
export async function removeFaceShading(sketch: Buffer, faces: FaceMap[]): Promise<Buffer> {
  const { data, info } = await sharp(sketch).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const scaled = (points: Point[]) => points.map((p) => ({ x: p.x * width, y: p.y * height }));
  const widthOf = (face: FaceMap) => (Math.max(...face.skin.map((p) => p.x)) - Math.min(...face.skin.map((p) => p.x))) * width;

  // What is never touched, from every face together: one person's hair
  // falls across another's cheek.
  const protect = new Uint8Array(width * height);
  for (const face of faces) {
    const faceWidth = widthOf(face);
    const own = new Uint8Array(width * height);
    // The smaller the face, the less of it is judged at all: its eyes are a
    // few fine lines close together, which is what hatching looks like.
    const guarded = faceWidth < TINY_FACE ? [...face.solid, ...face.eyes, ...face.brows] : faceWidth < SMALL_FACE ? [...face.solid, ...face.eyes] : face.solid;
    for (const box of guarded) {
      const left = Math.max(0, Math.floor(box.left * width));
      const right = Math.min(width - 1, Math.ceil(box.right * width));
      for (let y = Math.max(0, Math.floor(box.top * height)); y <= Math.min(height - 1, Math.ceil(box.bottom * height)); y++) {
        if (right >= left) own.fill(1, y * width + left, y * width + right + 1);
      }
    }
    for (const outline of face.hair) fillPolygon(own, width, height, scaled(outline));
    const grown = roundDilate(own, width, height, Math.max(1, Math.round(faceWidth * PROTECT_GROW)));
    for (let i = 0; i < grown.length; i++) if (grown[i]) protect[i] = 1;
    if (face.beardFrom !== null) {
      const skin = new Uint8Array(width * height);
      fillPolygon(skin, width, height, scaled(face.skin));
      const beard = roundDilate(skin, width, height, Math.round(faceWidth * BEARD_GROW));
      for (let i = Math.max(0, Math.floor(face.beardFrom * height)) * width; i < beard.length; i++) if (beard[i]) protect[i] = 1;
    }
  }

  let removed = 0;
  for (const face of faces) removed += cleanOneFace(data, width, height, channels, face, protect);
  console.info(`[export] face shading removed from ${faces.length} faces, ${faces.map((face) => Math.round(widthOf(face))).join(', ')} px wide (${removed} px of ink)`);
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

/** Every pixel within `reach` steps of `from`, walking only through `passable`. */
function reachable(passable: Uint8Array, from: Uint8Array, w: number, reach: number): Uint8Array {
  const seen = from.slice();
  let frontier: number[] = [];
  for (let i = 0; i < seen.length; i++) if (seen[i]) frontier.push(i);
  for (let d = 1; d <= reach && frontier.length; d++) {
    const next: number[] = [];
    for (const p of frontier) {
      const x = p % w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
        if (q < 0 || q >= passable.length || !passable[q] || seen[q]) continue;
        seen[q] = 1;
        next.push(q);
      }
    }
    frontier = next;
  }
  return seen;
}

/** The pixels of the connected group of `mask` that `start` belongs to (8-connected), marking them in `seen`. */
function groupFrom(mask: Uint8Array, seen: Uint8Array, start: number, w: number): number[] {
  const piece: number[] = [];
  const stack = [start];
  seen[start] = 1;
  while (stack.length) {
    const p = stack.pop() as number;
    piece.push(p);
    const x = p % w;
    for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w, x > 0 ? p - w - 1 : -1, x < w - 1 ? p - w + 1 : -1, x > 0 ? p + w - 1 : -1, x < w - 1 ? p + w + 1 : -1]) {
      if (q < 0 || q >= mask.length || seen[q] || !mask[q]) continue;
      seen[q] = 1;
      stack.push(q);
    }
  }
  return piece;
}

/** Removes the hatching on one face's skin, in place; returns how many ink pixels went. */
function cleanOneFace(data: Buffer, width: number, height: number, channels: number, face: FaceMap, protect: Uint8Array): number {
  const xs = face.skin.map((p) => p.x * width);
  const ys = face.skin.map((p) => p.y * height);
  const faceWidth = Math.max(...xs) - Math.min(...xs);
  if (faceWidth < 24) return 0;
  const pad = Math.round(faceWidth * 0.2);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)) - pad);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)) - pad);
  const w = Math.min(width, Math.ceil(Math.max(...xs)) + pad) - x0;
  const h = Math.min(height, Math.ceil(Math.max(...ys)) + pad) - y0;
  if (w < 8 || h < 8) return 0;

  const ink = new Uint8Array(w * h);
  const kept0 = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      ink[y * w + x] = data[((y + y0) * width + x + x0) * channels + 3] >= INK_ALPHA ? 1 : 0;
      kept0[y * w + x] = protect[(y + y0) * width + x + x0];
    }
  }
  const fill = (points: Point[]) => {
    const mask = new Uint8Array(w * h);
    fillPolygon(mask, w, h, points.map((p) => ({ x: p.x * width - x0, y: p.y * height - y0 })));
    return mask;
  };
  const open = (radius: number) => {
    const opened = roundDilate(roundErode(ink, w, h, radius), w, h, radius);
    for (let i = 0; i < opened.length; i++) opened[i] = opened[i] && ink[i] ? 1 : 0;
    return opened;
  };
  const thick = open(THIN_RADIUS_PX);
  const thin = new Uint8Array(w * h);
  const light = new Uint8Array(w * h);
  for (let i = 0; i < thin.length; i++) {
    thin[i] = ink[i] && !thick[i] ? 1 : 0;
    light[i] = thick[i] ? 0 : 1;
  }

  // The skin: where both answers put it, grown out to the nearest heavy
  // line (a long way across the lower cheeks, hardly at all higher up),
  // less anything that is plainly a mass of hair.
  const outline = fill(face.skin);
  if (face.agreed) {
    const other = fill(face.agreed);
    for (let i = 0; i < outline.length; i++) outline[i] = outline[i] && other[i] ? 1 : 0;
  }
  const below = reachable(light, outline, w, Math.max(1, Math.round(faceWidth * SKIN_GROW_BELOW)));
  const above = reachable(light, outline, w, Math.max(1, Math.round(faceWidth * SKIN_GROW_ABOVE)));
  const cheekRow = face.cheekLine === null ? h : Math.round(face.cheekLine * height - y0);
  const gap = Math.max(2, Math.round(faceWidth * HAIR_GAP));
  const core = Math.max(3, Math.round(faceWidth * HAIR_CORE));
  const joined = roundErode(roundDilate(thick, w, h, gap), w, h, gap);
  const hairy = roundDilate(roundErode(joined, w, h, core), w, h, core);
  const skin = new Uint8Array(w * h);
  for (let i = 0; i < skin.length; i++) skin[i] = (Math.floor(i / w) < cheekRow ? above[i] : below[i]) && !hairy[i] ? 1 : 0;

  const boxMask = (list: Box[]) => {
    const mask = new Uint8Array(w * h);
    for (const box of list) {
      const left = Math.max(0, Math.floor(box.left * width - x0));
      const right = Math.min(w - 1, Math.ceil(box.right * width - x0));
      for (let y = Math.max(0, Math.floor(box.top * height - y0)); y <= Math.min(h - 1, Math.ceil(box.bottom * height - y0)); y++) {
        if (right >= left) mask.fill(1, y * w + left, y * w + right + 1);
      }
    }
    return mask;
  };
  // The nose alone: its own lines are fine and curved, and are not taken
  // for the curved shading that is removed round an eye unless they lie in
  // hatching from end to end, up beside the bridge.
  const noseOnly = boxMask(face.nose);
  const noseBase = boxMask(face.nose.map((box) => ({ ...box, top: box.bottom - (box.bottom - box.top) * NOSE_BASE })));
  const nose = new Uint8Array(w * h);
  for (const box of [...face.nose, ...face.eyes, ...face.brows]) {
    const left = Math.max(0, Math.floor(box.left * width - x0));
    const right = Math.min(w - 1, Math.ceil(box.right * width - x0));
    for (let y = Math.max(0, Math.floor(box.top * height - y0)); y <= Math.min(h - 1, Math.ceil(box.bottom * height - y0)); y++) {
      if (right >= left) nose.fill(1, y * w + left, y * w + right + 1);
    }
  }
  // The fringe of a solid mass: the hairs of an eyebrow, the edge of a
  // beard, wisps at a hairline. A stroke that lies mostly within reach of
  // one is part of it. A hatching stroke that merely ends at an eyebrow has
  // most of its length out on the skin, and is not.
  const fringe = reachable(ink, open(Math.max(3, Math.round(faceWidth * MASS_RADIUS))), w, Math.round(faceWidth * MASS_REACH));

  // Which fine strokes are hatching: several of them side by side.
  const probe = Math.round(Math.min(HATCH_PROBE_MAX, Math.max(HATCH_PROBE_MIN, faceWidth * HATCH_PROBE)));
  const hatching = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!thin[y * w + x]) continue;
      for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
        let strokes = 0;
        let inside = false;
        for (let t = -probe; t <= probe; t++) {
          const px = x + dx * t;
          const py = y + dy * t;
          const on = px >= 0 && py >= 0 && px < w && py < h && thin[py * w + px] === 1;
          if (on && !inside) strokes++;
          inside = on;
        }
        if (strokes >= HATCH_STROKES) {
          hatching[y * w + x] = 1;
          break;
        }
      }
    }
  }
  const nearHatching = roundDilate(hatching, w, h, Math.round(probe / 2));

  // Each fine stroke is judged once, whole: hatching goes, a line on its
  // own stays. Then only what lies on the skin is taken.
  const gone = new Uint8Array(w * h);
  const seen = new Uint8Array(w * h);
  for (let start = 0; start < thin.length; start++) {
    if (!thin[start] || seen[start]) continue;
    const piece = groupFrom(thin, seen, start, w);
    let left = w, right = 0, top = h, bottom = 0, onNose = 0, onNoseOnly = 0, onNoseBase = 0, hatched = 0, beside = 0, guarded = 0, fringed = 0;
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (const p of piece) {
      const x = p % w;
      const y = (p - x) / w;
      sx += x;
      sy += y;
      sxx += x * x;
      syy += y * y;
      sxy += x * y;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (nose[p]) onNose++;
      if (noseOnly[p]) onNoseOnly++;
      if (noseBase[p]) onNoseBase++;
      if (kept0[p]) guarded++;
      if (fringe[p]) fringed++;
      if (hatching[p]) hatched++;
      if (nearHatching[p]) beside++;
    }
    // A stroke belongs to whatever most of it lies on. Mostly on a mouth, a
    // beard or a pair of spectacles, it is theirs and stays; mostly off
    // them, it is cheek shading that happens to run in under the edge of
    // their box, and goes whole rather than leave a stub there.
    if (guarded * 2 >= piece.length || fringed * 2 >= piece.length) continue;
    const length = Math.hypot(right - left + 1, bottom - top + 1);
    const big = faceWidth >= TINY_FACE;
    if (length < Math.max(SHORT_PX, faceWidth * (big ? SHORT_BIG : SHORT))) continue;
    // How far the stroke strays from a straight line: the spread of its
    // pixels across its own long axis against the spread along it.
    const n = piece.length;
    const vxx = sxx / n - (sx / n) ** 2;
    const vyy = syy / n - (sy / n) ** 2;
    const vxy = sxy / n - (sx / n) * (sy / n);
    const mid = (vxx + vyy) / 2;
    const swing = Math.sqrt(Math.max(0, mid * mid - (vxx * vyy - vxy * vxy)));
    const along = Math.sqrt(Math.max(0, mid + swing));
    const across = Math.sqrt(Math.max(0, mid - swing));
    const isHatching = hatched * 2 >= piece.length;
    // Not straight: a line that bends (an eyelid, a jaw, a curl) stays. But
    // cross-hatching is not one stroke either: it is many, crossing, joined
    // into a mesh, and it is the darkest shading there is. On a face large
    // enough to tell the two apart, a mesh that is hatching through and
    // through goes.
    if (across > Math.max(STRAIGHT_PX, along * STRAIGHT_BEND)) {
      const deep = hatched >= piece.length * MESH_HATCHED;
      const mesh = piece.length > length * MESH_STROKES * 3;
      // And the shading round an eye is drawn in short curved strokes, set
      // as close as any hatching: the darkest part of the client's files.
      // Short, so that a jaw or a hairline, which also has hatching all
      // along it, is not taken for one.
      const curvedShading = length <= faceWidth * CURVED_MAX && (onNoseOnly * 2 < piece.length || (hatched >= piece.length * NOSE_HATCHED && onNoseBase * 2 < piece.length));
      if (!(big && deep && (mesh || curvedShading))) continue;
    }
    if (onNose * 2 >= piece.length) {
      // On the nose or an eye only plain shading goes: a stroke that is
      // itself in the thick of hatching, and not a short one.
      if (!isHatching || length <= faceWidth * (big ? SHORT_BIG : NOSE_SHORT)) continue;
    } else if (!isHatching && (beside * 2 < piece.length || length >= faceWidth * LONE_LENGTH)) {
      continue;
    }
    // A stroke that lies mostly on the skin goes whole, so that no stub of
    // it is left sticking out past the edge of the outline.
    let onSkin = 0;
    for (const p of piece) if (skin[p]) onSkin++;
    const whole = onSkin >= piece.length * WHOLE_SHARE;
    for (const p of piece) if (whole || skin[p]) gone[p] = 1;
  }

  // Specks: what is left of a stroke that was mostly removed. A mole or a
  // bindi is no speck — it was never part of a removed stroke.
  const cut = roundDilate(gone, w, h, 1);
  const speck = Math.round(SPECK_AREA * (faceWidth / 400) ** 2);
  const rest = new Uint8Array(w * h);
  for (let i = 0; i < rest.length; i++) rest[i] = ink[i] && !gone[i] ? 1 : 0;
  const visited = new Uint8Array(w * h);
  for (let start = 0; start < rest.length; start++) {
    if (!rest[start] || visited[start]) continue;
    const piece = groupFrom(rest, visited, start, w);
    if (piece.length > speck) continue;
    if (piece.some((p) => cut[p]) && piece.every((p) => skin[p] && !kept0[p])) for (const p of piece) gone[p] = 1;
  }

  // Take the strokes out, with the soft edge round them: anything that is
  // no longer beside kept ink goes clear.
  const kept = new Uint8Array(w * h);
  for (let i = 0; i < kept.length; i++) kept[i] = ink[i] && !gone[i] ? 1 : 0;
  const besideKept = roundDilate(kept, w, h, 1);
  const cleared = roundDilate(gone, w, h, 1);
  let count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!cleared[i] || besideKept[i]) continue;
      const a = ((y + y0) * width + x + x0) * channels + 3;
      if (data[a] >= INK_ALPHA) count++;
      data[a] = 0;
    }
  }
  return count;
}
