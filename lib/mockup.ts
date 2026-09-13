/**
 * Photorealistic product mockup — the image the client actually posts on the
 * e-commerce listing.
 *
 * This is the app's SECOND Gemini call per design, and a deliberate one: the
 * canvas renderer (components/PendantPreview.tsx) is a fast 2D approximation
 * that's ideal for instant previews while the customer tries shapes and
 * metals, but it can't produce the polished-metal, bevelled-edge, bail-and-
 * studio-lighting product photograph the client's catalogue is built from.
 * Gemini can — so this runs on demand, once per design + metal the operator
 * explicitly asks for, never automatically and never on a slider drag.
 *
 * Pipeline:
 *   design request -> the same `resolvePendantGeometry` + `renderTransformedArtwork`
 *   the laser export uses (so the mockup can never show a different plate,
 *   crop or placement than the export) -> flat composite: plate filled with
 *   the metal's flat colour (+ enamel rim band if chosen), artwork multiplied
 *   on top, cream background -> Gemini, with a prompt whose whole job is
 *   "make this photoreal without changing anything" -> data URL.
 */

import sharp from 'sharp';
import { generateImageFromImage } from './gemini';
import { PENDANT_MATERIALS, RIM_BAND_WIDTH, RIM_COLORS } from './materials';
import { PENDANT_CATEGORIES } from './pendant-categories';
import { resolvePendantGeometry, type PendantGeometry } from './pendant-geometry';
import { PENDANT_SHAPES, PENDANT_VIEWBOX } from './pendant-shapes';
import { RASTER_SCALE, renderTransformedArtwork } from './laser-export';
import type { DesignRequest } from './design-request';

if (typeof window !== 'undefined') {
  throw new Error('lib/mockup.ts was imported into a browser bundle. This module is server-only.');
}

/** Soft cream studio backdrop — matches the client's own reference product shots. */
const BACKGROUND = '#f4efe6';

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** The plate alone: flat metal fill, optional enamel band inset from the edge, transparent outside. */
async function rasterizePlate(
  geometry: PendantGeometry,
  fill: string,
  rimHex: string | null,
  width: number,
  height: number,
): Promise<Buffer> {
  const d = escapeAttr(geometry.outerPath);
  // The band is a stroke centred on the outline, clipped to the plate so
  // only the inner half survives — a band exactly RIM_BAND_WIDTH wide,
  // flush with the edge.
  const band = rimHex
    ? `<path d="${d}" fill="none" stroke="${rimHex}" stroke-width="${RIM_BAND_WIDTH * 2}" clip-path="url(#plate)"/>`
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${PENDANT_VIEWBOX.width} ${PENDANT_VIEWBOX.height}">
  <defs><clipPath id="plate"><path d="${d}"/></clipPath></defs>
  <path d="${d}" fill="${fill}"/>
  ${band}
</svg>`;
  return sharp(Buffer.from(svg)).resize(width, height).png().toBuffer();
}

/** The flat design Gemini is asked to photograph. Exported for tests/debugging; opaque PNG. */
export async function buildMockupComposite(request: DesignRequest): Promise<Buffer> {
  const geometry = resolvePendantGeometry({
    designType: request.designType,
    shape: request.shape,
    engravingArea: request.engravingArea,
    contour: request.contour,
    transform: request.transform,
  });
  const material = PENDANT_MATERIALS[request.material];
  const rimHex =
    request.designType === 'standard' && PENDANT_SHAPES[request.shape].supportsRim
      ? RIM_COLORS[request.rimColor].hex
      : null;

  const width = PENDANT_VIEWBOX.width * RASTER_SCALE;
  const height = PENDANT_VIEWBOX.height * RASTER_SCALE;

  const [plate, artwork] = await Promise.all([
    rasterizePlate(geometry, material.flat, rimHex, width, height),
    renderTransformedArtwork(request.sketch, geometry, request.transform),
  ]);

  // The artwork PNG is already clipped to the plate, so multiplying it onto
  // the plate darkens the metal only where there is ink.
  return sharp(plate)
    .composite([{ input: artwork.png, blend: 'multiply' }])
    .flatten({ background: BACKGROUND })
    .png()
    .toBuffer();
}

function buildMockupPrompt(request: DesignRequest): string {
  const material = PENDANT_MATERIALS[request.material];
  const subject = request.category ? PENDANT_CATEGORIES[request.category].label : 'photo pendant';

  const plate =
    request.designType === 'edge-cut'
      ? `This is a SILHOUETTE-CUT pendant: the flat metal plate is cut a few millimetres outside the outline of the engraved artwork, following its shape — that irregular outline, with its small metal border, IS the edge of the pendant. Keep it exactly; do not put the artwork on a round, heart or any other backing plate, and do not add a frame. The plate already includes its own hanging ring at the top centre, cut from the same flat sheet with a round hole — keep that ring exactly as shown and do NOT add a separate bail.`
      : `The plate is a ${PENDANT_SHAPES[request.shape].label.toLowerCase()} shape. Keep its exact outline and proportions. Add a small matching ${material.label.toLowerCase()} bail (hanging loop) attached at the top centre so it can hang on a chain.`;

  const rimHex =
    request.designType === 'standard' && PENDANT_SHAPES[request.shape].supportsRim
      ? RIM_COLORS[request.rimColor]
      : null;
  const rim =
    rimHex && rimHex.hex
      ? `The plate has a ${rimHex.label.toLowerCase().replace(' rim', '')} band around its edge, exactly where and as wide as shown — render it as glossy vitreous enamel.`
      : '';

  return `You are given a flat 2D design of a custom engraved jewellery pendant (a ${subject} from a jeweller's catalogue): a ${material.mockupDescription} plate with a hand-engraved line-art portrait on it.

Render this EXACT pendant as a photorealistic, high-end product photograph for an online jewellery store.

- Metal: ${material.mockupDescription}, with realistic reflections and a soft bevelled edge.
- ${plate}
${rim ? `- ${rim}\n` : ''}- Nothing else may be added to the piece.
- The engraving must remain EXACTLY as shown: the same faces, the same line-art, the same position and size on the plate. Do not redraw, restyle, beautify, sharpen or move the portrait. Do not add any text, dates, names, hallmarks, purity stamps (no "925", no "22k"), gems or extra decoration anywhere on the piece.
- Present it front-facing and centred, lying flat on a plain, soft, light cream studio background with a gentle shadow, like a catalogue product shot.

Output only the rendered image.`;
}

export interface MockupResult {
  /** The photorealistic mockup as a data URL. */
  dataUrl: string;
  /** The flat composite that was sent to Gemini, as a data URL — what the mockup is expected to be faithful to. */
  compositeDataUrl: string;
}

export async function renderPendantMockup(request: DesignRequest): Promise<MockupResult> {
  const composite = await buildMockupComposite(request);
  const result = await generateImageFromImage({
    prompt: buildMockupPrompt(request),
    imageBytes: composite,
    mimeType: 'image/png',
  });
  return {
    dataUrl: `data:${result.mimeType};base64,${Buffer.from(result.bytes).toString('base64')}`,
    compositeDataUrl: `data:image/png;base64,${composite.toString('base64')}`,
  };
}
