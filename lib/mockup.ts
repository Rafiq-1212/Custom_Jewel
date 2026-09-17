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
import { renderTransformedArtwork } from './laser-export';
import type { DesignRequest } from './design-request';

if (typeof window !== 'undefined') {
  throw new Error('lib/mockup.ts was imported into a browser bundle. This module is server-only.');
}

/** Soft cream studio backdrop — matches the client's own reference product shots. */
const BACKGROUND = '#f4efe6';
/**
 * Raster pixels per viewBox unit for the images sent to the AI. The laser
 * export uses 10; at that size the pendant was only a few hundred pixels
 * across, hair strands were a pixel or two wide, and the AI would sometimes
 * paint a hair area as plain polished gold, which reads as a bald patch.
 */
const MOCKUP_RASTER_SCALE = 25;
/** White space kept around the pendant when cropping, as a fraction of its larger side. */
const CROP_PADDING = 0.08;

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

interface CropBox {
  /** The crop, in the coordinates of a canvas that has been extended by `pad` on all four sides. */
  left: number;
  top: number;
  width: number;
  height: number;
  pad: number;
}

/**
 * Bounding box of every pixel whose alpha is above zero, with the same
 * padding on all four sides.
 *
 * The padding used to be clamped to the canvas, which quietly made it
 * lopsided: a tall Cut to shape piece runs to the bottom of the viewBox, so
 * its design came out with 204 px of cream above and beside it and 70 px
 * below. The model treated that as a picture that was already cropped and
 * cropped it further, cutting the beard off the bottom of the pendant. So
 * the canvas is extended instead of the padding being trimmed.
 */
async function paddedAlphaBox(png: Buffer): Promise<CropBox> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * info.channels + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { left: 0, top: 0, width: info.width, height: info.height, pad: 0 };
  const pad = Math.round(Math.max(maxX - minX, maxY - minY) * CROP_PADDING);
  // In the extended canvas every coordinate shifts by `pad`, so the crop
  // starts at the bounding box's own minimum and is 2 * pad larger.
  return {
    left: minX,
    top: minY,
    width: maxX - minX + 1 + pad * 2,
    height: maxY - minY + 1 + pad * 2,
    pad,
  };
}

/** Grows `png` by `box.pad` on every side with `background`, then takes the crop. */
async function padAndCrop(png: Buffer, box: CropBox, background: string): Promise<Buffer> {
  const extended =
    box.pad === 0
      ? png
      : await sharp(png)
          .extend({ top: box.pad, bottom: box.pad, left: box.pad, right: box.pad, background })
          .png()
          .toBuffer();
  return sharp(extended)
    .extract({ left: box.left, top: box.top, width: box.width, height: box.height })
    .png()
    .toBuffer();
}

export interface MockupImages {
  /** The flat design to be photographed: metal plate with the engraving on it, cream background. */
  composite: Buffer;
  /** The engraving alone, black on white, same crop. Tells the AI exactly what every engraved line is. */
  engraving: Buffer;
}

/**
 * The two images Gemini is given, both cropped tight to the pendant and at
 * MOCKUP_RASTER_SCALE so the engraving is large and legible.
 */
export async function buildMockupImages(request: DesignRequest): Promise<MockupImages> {
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

  const width = PENDANT_VIEWBOX.width * MOCKUP_RASTER_SCALE;
  const height = PENDANT_VIEWBOX.height * MOCKUP_RASTER_SCALE;

  const [plate, artwork] = await Promise.all([
    rasterizePlate(geometry, material.flat, rimHex, width, height),
    renderTransformedArtwork(request.sketch, geometry, request.transform, MOCKUP_RASTER_SCALE),
  ]);
  const box = await paddedAlphaBox(plate);

  // The artwork PNG is already clipped to the plate, so multiplying it onto
  // the plate darkens the metal only where there is ink.
  // Composite first, crop in a separate pass: sharp always applies extract()
  // before composite() within one pipeline, which would shrink the base below
  // the size of the artwork layer.
  const fullComposite = await sharp(plate)
    .composite([{ input: artwork.png, blend: 'multiply' }])
    .flatten({ background: BACKGROUND })
    .png()
    .toBuffer();
  const composite = await padAndCrop(fullComposite, box, BACKGROUND);
  const engraving = await padAndCrop(await sharp(artwork.png).flatten({ background: '#ffffff' }).png().toBuffer(), box, '#ffffff');
  return { composite, engraving };
}

/** The flat design Gemini is asked to photograph. Kept for debugging; opaque PNG. */
export async function buildMockupComposite(request: DesignRequest): Promise<Buffer> {
  return (await buildMockupImages(request)).composite;
}

function buildMockupPrompt(request: DesignRequest): string {
  const material = PENDANT_MATERIALS[request.material];
  const subject = request.category ? PENDANT_CATEGORIES[request.category].label : 'photo pendant';

  const plate =
    request.designType === 'edge-cut'
      ? `This is a SILHOUETTE-CUT pendant: the flat metal plate is cut a few millimetres outside the outline of the engraved artwork, following its shape — that irregular outline, with its small metal border, IS the edge of the pendant. Keep it exactly; do not put the artwork on a round, heart or any other backing plate, and do not add a frame. The plate already includes its own hanging tab, cut from the same flat sheet with a round hole through it — keep that tab and its hole exactly where image 1 puts them. Then add a small matching ${material.label.toLowerCase()} bail (a hanging loop) threaded through that hole, the way a jeweller hangs a cut piece, so it can go on a chain. THE METAL PLATE HAS EXACTLY ONE HOLE, the one in image 1: never cut a second hole anywhere, and never punch one through the portrait.`
      : `The plate is a ${PENDANT_SHAPES[request.shape].label.toLowerCase()} shape. Keep its exact outline and proportions. Add a small matching ${material.label.toLowerCase()} bail (a hanging loop) at the top centre so it can hang on a chain. Do not cut any hole through the plate itself.`;

  const rimHex =
    request.designType === 'standard' && PENDANT_SHAPES[request.shape].supportsRim
      ? RIM_COLORS[request.rimColor]
      : null;
  const rim =
    rimHex && rimHex.hex
      ? `The plate has a ${rimHex.label.toLowerCase().replace(' rim', '')} band around its edge, exactly where and as wide as shown — render it as glossy vitreous enamel.`
      : '';

  return `You are given two images of one custom engraved jewellery pendant (a ${subject} from a jeweller's catalogue).
Image 1 is the flat design: a ${material.mockupDescription} plate with a hand-engraved line-art portrait on it.
Image 2 is the engraving artwork alone, black on white, in exactly the same position and size. It shows every engraved line at full detail.

Render this EXACT pendant as a photorealistic, high-end product photograph for an online jewellery store.

- Metal: ${material.mockupDescription}. ${material.mockupFinish}
- ${plate}
${rim ? `- ${rim}\n` : ''}- Nothing else may be added to the piece.
- ENGRAVING DETAIL (most important): reproduce the engraving line for line from image 2. ${material.mockupEngraving} Every black area in image 2 is deeply engraved and must look DARK in the photo: hair, beards, eyebrows, eyes, shading and clothing patterns keep all their dark strokes and dark masses, at the same thickness and the same density as image 2. A mass of hair stays a mass, not a few loose strands. Never lighten, thin out, fade or polish over any engraved area, and never replace a dark hair area with plain shiny metal. Only the white areas of image 2 are bare metal.
- The engraving must remain EXACTLY as shown: the same faces, the same line-art, the same position and size on the plate. Do not redraw, restyle, beautify, sharpen or move the portrait. Do not add any text, dates, names, hallmarks, purity stamps (no "925", no "22k"), gems or extra decoration anywhere on the piece.
- Present it front-facing and centred, lying flat on a plain, soft, light cream studio background with a gentle shadow, like a catalogue product shot.
- Show the WHOLE piece, with clear background all the way around it. Never crop it, never let any part of it run off an edge of the picture, and never zoom in on it: the top of the bail and the very bottom of the plate both have to be inside the frame with room to spare.

Output only the rendered image.`;
}

export interface MockupResult {
  /** The photorealistic mockup as a data URL. */
  dataUrl: string;
  /** The flat composite that was sent to Gemini, as a data URL — what the mockup is expected to be faithful to. */
  compositeDataUrl: string;
}

export async function renderPendantMockup(request: DesignRequest): Promise<MockupResult> {
  const { composite, engraving } = await buildMockupImages(request);
  const result = await generateImageFromImage({
    prompt: buildMockupPrompt(request),
    images: [
      { bytes: composite, mimeType: 'image/png' },
      { bytes: engraving, mimeType: 'image/png' },
    ],
  });
  return {
    dataUrl: `data:${result.mimeType};base64,${Buffer.from(result.bytes).toString('base64')}`,
    compositeDataUrl: `data:image/png;base64,${composite.toString('base64')}`,
  };
}
