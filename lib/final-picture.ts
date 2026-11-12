/**
 * The final gold/silver picture of a design, drawn on the server: the look
 * of the tool's preview (components/PendantPreview.tsx) — a metal plate with
 * its gradient and sheen, the sketch engraved into it, a bevelled edge — with
 * the workshop's bail on top, small on a cream background.
 *
 * It used to be painted in the customer's own browser and uploaded, and some
 * phones painted it wrong: the engraving's dark lines went missing and the
 * saved picture showed only faint light ones (11 Nov). Drawn here it comes
 * out the same whoever asks. The browser preview stays for live dragging;
 * this is what is saved and shown as the product photo.
 *
 * The engraving is placed by the same `renderTransformedArtwork` the laser
 * files use, so it can never sit differently from what is cut.
 */

import sharp from 'sharp';
import { BAIL_BOTTOM_HALF_WIDTH, BAIL_DROP, BAIL_HEIGHT, BAIL_TOP_HALF_WIDTH, bailPath } from './bail';
import type { DesignRequest } from './design-request';
import { renderTransformedArtwork } from './laser-export';
import { PENDANT_MATERIALS, RIM_BAND_WIDTH, RIM_COLORS, type PendantMaterial } from './materials';
import { resolvePendantGeometry, type PendantGeometry } from './pendant-geometry';
import { PENDANT_SHAPES, PENDANT_VIEWBOX } from './pendant-shapes';

if (typeof window !== 'undefined') {
  throw new Error('lib/final-picture.ts was imported into a browser bundle. This module is server-only.');
}

/** Pixels per viewBox unit: the plate comes out 900 px wide, as the browser drew it. */
const UNIT = 9;
const BACKGROUND = '#f4efe6';
/** The pendant's height as a fraction of the picture's, and the picture's width to height: as the product photo. */
const PENDANT_HEIGHT = 0.42;
const ASPECT = 0.85;
/** The bail's hole radius on a shape with no hole of its own: the heart frame's (lib/pendant-shapes.ts). */
const CATALOGUE_BAIL_HOLE = 2.4;
const GRADIENT_STOPS = [0, 0.24, 0.46, 0.68, 1];

function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function svg(width: number, height: number, body: string): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width / UNIT} ${height / UNIT}">${body}</svg>`,
  );
}

function metalStops(metal: PendantMaterial): string {
  return metal.gradient.map((colour, i) => `<stop offset="${GRADIENT_STOPS[i]}" stop-color="${colour}"/>`).join('');
}

/** The plate: metal gradient, a faint shadow, and the studio sheen. */
function plateSvg(geometry: PendantGeometry, metal: PendantMaterial, width: number, height: number): Buffer {
  const d = attr(geometry.outerPath);
  return svg(
    width,
    height,
    `<defs>
      <linearGradient id="metal" gradientUnits="userSpaceOnUse" x1="10" y1="15" x2="90" y2="110">${metalStops(metal)}</linearGradient>
      <radialGradient id="sheen" gradientUnits="userSpaceOnUse" cx="35" cy="45" r="55">
        <stop offset="0" stop-color="#fff" stop-opacity="0.55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
      </radialGradient>
      <clipPath id="plate"><path d="${d}" clip-rule="evenodd"/></clipPath>
      <filter id="shadow" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="0.17"/></filter>
    </defs>
    <path d="${d}" fill-rule="evenodd" fill="#000" opacity="0.25" transform="translate(0 0.17)" filter="url(#shadow)"/>
    <path d="${d}" fill-rule="evenodd" fill="url(#metal)"/>
    <rect x="0" y="0" width="${PENDANT_VIEWBOX.width}" height="${PENDANT_VIEWBOX.height}" fill="url(#sheen)" clip-path="url(#plate)"/>`,
  );
}

/** Over the engraving: the enamel band, the bevel round the edge, and the rim line of a catalogue shape. */
function edgeSvg(geometry: PendantGeometry, metal: PendantMaterial, rimHex: string | null, width: number, height: number): Buffer {
  const d = attr(geometry.outerPath);
  const band = rimHex
    ? `<path d="${attr(geometry.rimPath)}" fill="none" stroke="${rimHex}" stroke-width="${RIM_BAND_WIDTH * 2}"/>`
    : '';
  const dark = [
    [4.5, 0.1],
    [3, 0.1],
    [1.6, 0.12],
  ]
    .map(([w, a]) => `<path d="${d}" fill="none" stroke="#000" stroke-opacity="${a}" stroke-width="${w}"/>`)
    .join('');
  const light = [
    [2.2, 0.16],
    [1.1, 0.22],
  ]
    .map(([w, a]) => `<path d="${d}" fill="none" stroke="#fff" stroke-opacity="${a}" stroke-width="${w}" transform="translate(-1.1 -1.1)"/>`)
    .join('');
  const rim = geometry.hasDecorativeRim ? `<path d="${d}" fill="none" stroke="${metal.rim}" stroke-width="1.1"/>` : '';
  return svg(
    width,
    height,
    `<defs><clipPath id="plate"><path d="${d}" clip-rule="evenodd"/></clipPath></defs>
    <g clip-path="url(#plate)">${band}${dark}${light}</g>${rim}`,
  );
}

/** The bail as polished metal; the same drawing as the browser's (components/PendantPreview.tsx, drawBail). */
function bailSvg(
  hole: { cx: number; cy: number; r: number },
  metal: PendantMaterial,
  width: number,
  height: number,
  /** Where the pendant's own viewBox origin sits in this picture, in units. */
  origin: { x: number; y: number },
): Buffer {
  const d = bailPath(hole.cx, hole.cy, hole.r);
  const [light, mid, , , shadow] = metal.gradient;
  const half = hole.r * BAIL_TOP_HALF_WIDTH;
  const bottom = hole.cy + hole.r * BAIL_DROP;
  const top = bottom - hole.r * BAIL_HEIGHT;
  const x1 = hole.cx - half;
  const x2 = hole.cx + half;
  return svg(
    width,
    height,
    `<defs>
      <linearGradient id="across" gradientUnits="userSpaceOnUse" x1="${x1}" y1="0" x2="${x2}" y2="0">
        <stop offset="0" stop-color="${shadow}"/><stop offset="0.16" stop-color="${mid}"/><stop offset="0.36" stop-color="${light}"/>
        <stop offset="0.5" stop-color="#fff"/><stop offset="0.62" stop-color="${light}"/><stop offset="0.84" stop-color="${mid}"/>
        <stop offset="1" stop-color="${shadow}"/>
      </linearGradient>
      <linearGradient id="down" gradientUnits="userSpaceOnUse" x1="0" y1="${top}" x2="0" y2="${bottom + hole.r * 0.5}">
        <stop offset="0" stop-color="#fff" stop-opacity="0.28"/><stop offset="0.35" stop-color="#fff" stop-opacity="0"/>
        <stop offset="0.8" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.38"/>
      </linearGradient>
      <clipPath id="bail"><path d="${d}"/></clipPath>
      <filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="0.6"/></filter>
      <filter id="streak" x="-50%" y="-10%" width="200%" height="120%"><feGaussianBlur stdDeviation="${Math.max(0.07, half * 0.12)}"/></filter>
    </defs>
    <g transform="translate(${origin.x} ${origin.y})">
    <path d="${d}" fill="#000" opacity="0.32" transform="translate(0.35 0.6)" filter="url(#soft)"/>
    <g clip-path="url(#bail)">
      <rect x="${x1 - 1}" y="${top - 1}" width="${half * 2 + 2}" height="${bottom - top + hole.r + 2}" fill="url(#across)"/>
      <rect x="${x1 - 1}" y="${top - 1}" width="${half * 2 + 2}" height="${bottom - top + hole.r + 2}" fill="url(#down)"/>
      <line x1="${hole.cx - half * 0.32}" y1="${top + half * 0.75}" x2="${hole.cx - hole.r * BAIL_BOTTOM_HALF_WIDTH * 0.3}" y2="${bottom - hole.r * 0.9}"
        stroke="#fff" stroke-opacity="0.75" stroke-width="${Math.max(0.12, half * 0.16)}" stroke-linecap="round" filter="url(#streak)"/>
      <path d="${d}" fill="none" stroke="#000" stroke-opacity="0.22" stroke-width="${half * 0.3}"/>
      <path d="${d}" fill="none" stroke="#fff" stroke-opacity="0.5" stroke-width="${half * 0.1}" transform="translate(${-half * 0.06} ${-half * 0.06})"/>
    </g>
    <path d="${d}" fill="none" stroke="#000" stroke-opacity="0.4" stroke-width="${Math.max(0.08, hole.r * 0.06)}"/>
    </g>`,
  );
}

/** Bounding box of the pixels whose alpha is above `threshold`, and the top of the middle column. */
async function bounds(png: Buffer, threshold = 16) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * info.channels + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const centre = Math.round((minX + maxX) / 2);
  let top = minY;
  for (let y = minY; y <= maxY; y++) {
    if (data[(y * info.width + centre) * info.channels + 3] > threshold) {
      top = y;
      break;
    }
  }
  return { minX, minY, maxX, maxY, centre, top };
}

/** The finished picture, as a JPEG. */
export async function renderFinalPicture(request: DesignRequest): Promise<Buffer> {
  const geometry = resolvePendantGeometry({
    designType: request.designType,
    shape: request.shape,
    engravingArea: request.engravingArea,
    contour: request.contour,
    transform: request.transform,
  });
  const metal = PENDANT_MATERIALS[request.material];
  const rimHex =
    request.designType === 'standard' && PENDANT_SHAPES[request.shape].supportsRim ? RIM_COLORS[request.rimColor].hex : null;
  const width = PENDANT_VIEWBOX.width * UNIT;
  const height = PENDANT_VIEWBOX.height * UNIT;

  const plate = await sharp(plateSvg(geometry, metal, width, height)).png().toBuffer();
  const artwork = (await renderTransformedArtwork(request.sketch, geometry, request.transform, UNIT)).png;
  // The engraving's lit wall: its ink in white, shifted half a unit towards the light.
  const shift = Math.round(0.5 * UNIT);
  const inkAlpha = await sharp(artwork).ensureAlpha().extractChannel('alpha').linear(0.55, 0).toBuffer();
  // Two passes: within one, sharp crops before it pads.
  const padded = await sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
    .joinChannel(inkAlpha)
    .extend({ right: shift, bottom: shift, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const shoulder = await sharp(padded).extract({ left: shift, top: shift, width, height }).png().toBuffer();

  const pendant = await sharp(plate)
    .composite([
      { input: shoulder, blend: 'screen' },
      { input: artwork, blend: 'multiply' },
      { input: edgeSvg(geometry, metal, rimHex, width, height) },
    ])
    .png()
    .toBuffer();

  // Where the bail goes: through the piece's own hole, or on the top centre of a catalogue shape.
  const box = await bounds(plate);
  const hole =
    geometry.hangingHole ?? { cx: box.centre / UNIT, cy: box.top / UNIT + CATALOGUE_BAIL_HOLE * 0.9, r: CATALOGUE_BAIL_HOLE };
  const bailTop = Math.floor((hole.cy + hole.r * BAIL_DROP - hole.r * BAIL_HEIGHT) * UNIT) - 2;
  const minY = Math.min(box.minY, bailTop);

  // Small in the middle of a larger cream picture, like the product photo.
  const outHeight = Math.round((box.maxY - minY + 1) / PENDANT_HEIGHT);
  const outWidth = Math.max(box.maxX - box.minX + 2, Math.round(outHeight * ASPECT));
  const offsetX = Math.round(outWidth / 2 - (box.minX + box.maxX) / 2);
  const offsetY = Math.round(outHeight / 2 - (minY + box.maxY) / 2);

  // The pendant cropped to itself (it always fits), then the bail over it, which may stand above the plate's canvas.
  const crop = await sharp(pendant)
    .extract({ left: box.minX, top: box.minY, width: box.maxX - box.minX + 1, height: box.maxY - box.minY + 1 })
    .png()
    .toBuffer();
  const bail = bailSvg(hole, metal, outWidth, outHeight, { x: offsetX / UNIT, y: offsetY / UNIT });
  return sharp({ create: { width: outWidth, height: outHeight, channels: 3, background: BACKGROUND } })
    .composite([{ input: crop, left: box.minX + offsetX, top: box.minY + offsetY }, { input: bail }])
    .jpeg({ quality: 92 })
    .toBuffer();
}
