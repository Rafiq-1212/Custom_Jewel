/**
 * Each face drawn again close up, and laid back over the drawing.
 *
 * The inker redraws a face instead of following the pencils: in a check of
 * ten photos on 31 Oct, half the faces came back slimmer, longer, younger or
 * with another nose and mouth, although the photo edit and the trace had
 * both kept them exactly. Inked close up from the trace, the faces drifted
 * just the same. Converted straight from the photo — the head cut out,
 * enlarged and turned into an engraving, with no pencils to reinterpret —
 * the boy, the bearded man and the girl tested kept their own face shape,
 * nose and smile. That conversion rides in the same batch job as the
 * drawing (lib/gemini-batch.ts `extras`). At collect time each close-up is
 * lined up against the face in the drawing and blended over it; one that
 * cannot be lined up is left out, and the drawing keeps its own face.
 */

import sharp from 'sharp';
import type { GenerateImageFromImageInput } from './gemini';
import type { Region } from './ink-filter';

if (typeof window !== 'undefined') {
  throw new Error('lib/face-redraw.ts was imported into a browser bundle. This module is server-only.');
}

/** A head the close-up is made of: its square box (0-1 of the picture) and what the photo shows about that person. */
export interface Head {
  box: Region;
  facts: string;
}

/** Side of the enlarged close-up sent to the inker, in pixels. */
const CLOSE_UP_PX = 1024;
/** At most this many close-ups per drawing: a large group's faces are each tiny, and every one costs a drawing. */
const MAX_HEADS = 6;
/** Sample size, in pixels, at which a close-up is first lined up with the drawing... */
const SAMPLE = 96;
/** ...and then finely. */
const FINE_SAMPLE = 320;
/** The close-up is searched for this far beyond its box, as a share of the box side. */
const SEARCH = 0.12;
/** A close-up whose best match with the drawing's face is below this is not used. */
const MIN_MATCH = 0.6;

const FACE_PROMPT = `Convert this photograph into a black-and-white pen-and-ink portrait engraving on a plain white background. This is a TRACING of this exact photo, not a new drawing: every line sits exactly on an edge of this photograph, at exactly this framing — nothing is moved, resized, re-framed, straightened or redrawn, and anything cut off at an edge stays cut off. The face is this exact person at this exact age: the face shape and width, the cheeks, the jaw and chin, the eyes, the eyebrows, the nose and nostrils, the lips and the smile follow the photo exactly. Never make the face slimmer, longer, younger, fairer, more regular or prettier. Keep the skin light and clean: mostly white paper, with a few fine, widely spaced hatching lines only where the photo has real shadow — no dark patches round the eyes, beside the nose or on the cheeks. Hair in fine strands. Pure black ink on white only: no grey wash, no colour, no background.`;

/** A head box from the face check, kept inside the picture. */
function headBox(head: Region): Region {
  return { left: Math.max(0, head.left), top: Math.max(0, head.top), right: Math.min(1, head.right), bottom: Math.min(1, head.bottom) };
}

/** The heads to draw close up, largest first, with each person's facts. */
export function headsFor(regions: Region[], facts: string[]): Head[] {
  return regions
    .map((region, i) => ({ box: headBox(region), facts: facts[i] ?? '' }))
    .sort((a, b) => b.box.right - b.box.left - (a.box.right - a.box.left))
    .slice(0, MAX_HEADS);
}

/** The square, in pixels, round a head box on a picture of this size: as wide as the head's longer side, inside the picture. */
function pixels(box: Region, width: number, height: number) {
  const side = Math.max(1, Math.min(width, height, Math.round(Math.max((box.right - box.left) * width, (box.bottom - box.top) * height))));
  const left = Math.max(0, Math.min(width - side, Math.round(((box.left + box.right) / 2) * width - side / 2)));
  const top = Math.max(0, Math.min(height - side, Math.round(((box.top + box.bottom) / 2) * height - side / 2)));
  return { left, top, side };
}

async function cut(image: Buffer, box: Region): Promise<Buffer> {
  const { width = 0, height = 0 } = await sharp(image).metadata();
  const { left, top, side } = pixels(box, width, height);
  return sharp(image).flatten({ background: '#ffffff' }).extract({ left, top, width: side, height: side }).resize(CLOSE_UP_PX, CLOSE_UP_PX).png().toBuffer();
}

/** The close-up drawing requests, one per head, to ride with the main drawing. */
export async function closeUpRequests(heads: Head[], photo: Buffer, extra: (facts: string) => string): Promise<GenerateImageFromImageInput[]> {
  return Promise.all(
    heads.map(async (head) => ({
      prompt: [FACE_PROMPT, extra(head.facts)].filter(Boolean).join('\n\n'),
      images: [{ bytes: await cut(photo, head.box), mimeType: 'image/png' }],
      imageSize: '1K' as const,
      temperature: 0.1,
    })),
  );
}

/** Greyscale samples centred on their mean and scaled to unit length, for correlation. */
function normalise(data: Uint8Array | Buffer): Float32Array {
  const out = new Float32Array(data.length);
  let mean = 0;
  for (let i = 0; i < data.length; i++) mean += data[i];
  mean /= data.length || 1;
  let norm = 0;
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i] - mean;
    norm += out[i] * out[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/**
 * Where the close-up matches the drawing best, as a shift in pixels from its
 * box: tried at every step of `sample` pixels across the box, within `range`
 * pixels of `from`.
 */
async function bestShift(
  drawing: { data: Buffer; width: number; height: number },
  closeUp: Buffer,
  box: { left: number; top: number; side: number },
  sample: number,
  from: { dx: number; dy: number },
  range: number,
): Promise<{ score: number; dx: number; dy: number }> {
  const { width, height } = drawing;
  const scale = sample / box.side;
  const near = { left: Math.max(0, box.left + from.dx - range), top: Math.max(0, box.top + from.dy - range) };
  const nearW = Math.min(width, box.left + from.dx + box.side + range) - near.left;
  const nearH = Math.min(height, box.top + from.dy + box.side + range) - near.top;
  if (nearW < box.side / 2 || nearH < box.side / 2) return { score: -1, dx: 0, dy: 0 };
  const around = await sharp(drawing.data, { raw: { width, height, channels: 1 } })
    .extract({ left: near.left, top: near.top, width: nearW, height: nearH })
    .resize(Math.max(1, Math.round(nearW * scale)), Math.max(1, Math.round(nearH * scale)), { fit: 'fill' })
    .blur(1.5)
    .extractChannel(0)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const small = await sharp(closeUp).flatten({ background: '#ffffff' }).greyscale().resize(sample, sample, { fit: 'fill' }).blur(1.5).extractChannel(0).raw().toBuffer();
  const target = normalise(small);
  const window = new Uint8Array(sample * sample);
  let best = { score: -1, dx: 0, dy: 0 };
  const steps = Math.ceil(range * scale);
  for (let sy = -steps; sy <= steps; sy++) {
    for (let sx = -steps; sx <= steps; sx++) {
      const x0 = Math.round((box.left + from.dx - near.left) * scale) + sx;
      const y0 = Math.round((box.top + from.dy - near.top) * scale) + sy;
      if (x0 < 0 || y0 < 0 || x0 + sample > around.info.width || y0 + sample > around.info.height) continue;
      for (let y = 0; y < sample; y++) for (let x = 0; x < sample; x++) window[y * sample + x] = around.data[(y0 + y) * around.info.width + x0 + x];
      const here = normalise(window);
      let score = 0;
      for (let i = 0; i < here.length; i++) score += here[i] * target[i];
      if (score > best.score) best = { score, dx: from.dx + Math.round(sx / scale), dy: from.dy + Math.round(sy / scale) };
    }
  }
  return best;
}

/**
 * Lays each close-up over its face in the drawing. The close-up is slid
 * round its box to where it matches the drawing best (the inker keeps the
 * framing only roughly) — first coarsely, then to a pixel or two — and
 * blended in through a soft oval round the face, so the hair and outline
 * round it stay the drawing's own.
 */
export async function layFaces(drawing: Buffer, heads: Pick<Head, 'box'>[], closeUps: (Buffer | null)[]): Promise<Buffer> {
  const { data, info } = await sharp(drawing).flatten({ background: '#ffffff' }).greyscale().extractChannel(0).raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.from(data);
  const { width, height } = info;
  for (let h = 0; h < heads.length; h++) {
    const closeUp = closeUps[h];
    if (!closeUp) continue;
    const { left, top, side } = pixels(heads[h].box, width, height);
    const page = { data: out, width, height };
    const coarse = await bestShift(page, closeUp, { left, top, side }, SAMPLE, { dx: 0, dy: 0 }, Math.round(side * SEARCH));
    const best = coarse.score < MIN_MATCH ? coarse : await bestShift(page, closeUp, { left, top, side }, FINE_SAMPLE, coarse, Math.ceil(side / SAMPLE) + 1);
    if (best.score < MIN_MATCH) {
      console.info(`[sketch] face ${h + 1}: close-up does not line up with the drawing (match ${best.score.toFixed(2)}), keeping the drawing's face`);
      continue;
    }
    console.info(`[sketch] face ${h + 1}: close-up laid over the drawing (match ${best.score.toFixed(2)}, moved ${best.dx}, ${best.dy} px)`);
    const px = left + best.dx;
    const py = top + best.dy;
    const face = await sharp(closeUp).flatten({ background: '#ffffff' }).greyscale().extractChannel(0).resize(side, side, { fit: 'fill' }).raw().toBuffer();
    // A soft oval over the face itself: eyebrows to chin, cheek to cheek.
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        const ex = (x / side - 0.5) / 0.3;
        const ey = (y / side - 0.53) / 0.36;
        const d = Math.sqrt(ex * ex + ey * ey);
        const weight = d <= 1 ? 1 : d >= 1.25 ? 0 : (1.25 - d) / 0.25;
        if (weight === 0) continue;
        const tx = px + x;
        const ty = py + y;
        if (tx < 0 || ty < 0 || tx >= width || ty >= height) continue;
        const i = ty * width + tx;
        out[i] = Math.round(weight * face[y * side + x] + (1 - weight) * out[i]);
      }
    }
  }
  return sharp(out, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
}
