/**
 * Laser-cutting export assets: SVG, DXF and a transparent PNG.
 *
 * This is Operation 2 territory — deterministic geometry and raster
 * processing on the existing `masterSketch`, never a new AI call. It runs
 * once per "Download" click, on demand, using exactly the shape + transform
 * the customer is currently looking at in the live preview.
 *
 * On the 3DM request: a Rhino .3dm is a 3D-modeling interchange format, and
 * no laser cutter or engraver reads it directly — the formats that matter for
 * that job are exactly the three this module produces. A .3dm containing
 * nothing but these same 2D curves, with no true relief/depth data (which
 * would require real jewellery-CAD modelling this app has no way to invent
 * credibly from a 2D sketch), would be strictly less useful than the SVG
 * already is. It was left out for that reason rather than by oversight — see
 * the README for the full explanation.
 *
 * PIPELINE
 * ========
 *   masterSketch (transparent PNG)
 *        |
 *        v
 *   resize/rotate the sketch with sharp's own raster ops (not SVG — see the
 *   note on `renderTransformedArtwork` below), composite onto a blank
 *   transparent canvas at the computed position, then multiply its alpha by
 *   a rasterized shape mask                                            [A]
 *        |
 *        v
 *   [A] IS the transparent PNG deliverable, already at high resolution
 *   (deliverable 3: PNG, no background)
 *        |
 *        v
 *   flatten onto white, run potrace ------------------> traced <path> of the engraving's ink
 *        |
 *        v
 *   compose final SVG: shape outline (original path, exact arcs)
 *                    + traced engraving path                          (deliverable 1: SVG)
 *        |
 *        v
 *   flatten every curve to polylines, scale to real-world millimeters,
 *   write LWPOLYLINE / CIRCLE entities                                (deliverable 2: DXF)
 */

import sharp from 'sharp';
import { trace as potraceTrace, type PotraceOptions } from 'potrace';
import { buildDxf, type DxfCircleSpec, type DxfPolylineSpec } from './dxf-writer';
import { PENDANT_MATERIALS, type MaterialId } from './materials';
import {
  coverFit,
  resolvePendantGeometry,
  type DesignType,
  type EdgeCutStyle,
  type PendantGeometry,
  type SilhouetteContour,
} from './pendant-geometry';
import { PENDANT_VIEWBOX, type PendantTransform, type ShapeId } from './pendant-shapes';
import { flattenPath, type Point } from './svg-path-flatten';

if (typeof window !== 'undefined') {
  throw new Error('lib/laser-export.ts was imported into a browser bundle. This module is server-only.');
}

/** Raster pixels per viewBox unit when rendering for tracing and PNG export. */
const RASTER_SCALE = 10;
/** Default physical width of the exported pendant, in millimeters. */
const DEFAULT_WIDTH_MM = 25;

const POTRACE_OPTIONS: PotraceOptions = {
  blackOnWhite: true,
  turdSize: 4,
  optCurve: true,
  threshold: 180,
};

function decodeDataUrl(dataUrl: string): { buffer: Buffer; mimeType: string } {
  const match = /^data:([\w/+.-]+);base64,(.+)$/.exec(dataUrl);
  if (!match) throw new Error('Expected a base64 data: URL.');
  return { buffer: Buffer.from(match[2], 'base64'), mimeType: match[1] };
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/**
 * Rasterize the shape's silhouette alone — no embedded image, just a filled
 * vector path — to a single-channel coverage mask (white = keep). Kept
 * deliberately separate from `renderTransformedArtwork`: see the long comment
 * there for why the two are not combined into one `<clipPath>` + `<image>`
 * SVG the way an earlier version of this file did.
 */
async function rasterizeShapeMask(shapePath: string, width: number, height: number): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${PENDANT_VIEWBOX.width} ${PENDANT_VIEWBOX.height}">
  <path d="${escapeAttr(shapePath)}" fill="#ffffff"/>
</svg>`;
  return sharp(Buffer.from(svg)).resize(width, height).toColourspace('b-w').raw().toBuffer();
}

/**
 * Place the sketch at its computed position/size/rotation and clip it to the
 * shape, entirely in sharp's raster pipeline — no SVG `<image href="data:...">`
 * embedding anywhere in this function.
 *
 * An earlier version did the placement by embedding the sketch as an
 * `<image>` inside an SVG `<g transform="translate(...) scale(...)">`, and it
 * had a real, reproducible bug: for a `masterSketch` reconstructed from a raw
 * pixel buffer (exactly what `lib/image-processing.ts` produces) — as opposed
 * to a PNG encoded directly from an SVG render — librsvg would silently
 * ignore the nested `scale()`/`translate()` and draw the image at native
 * size, uncropped, ignoring the shape clip entirely. A raw-buffer PNG and an
 * SVG-encoded PNG evidently don't carry identical density/metadata, and
 * `<image>` embedding leans on that in a way this app has no business
 * depending on. Doing the resize/rotate/position with sharp's own pixel
 * operations — which this codebase already trusts and has verified precisely
 * — sidesteps the whole question. SVG is used only for the mask below, a
 * plain vector fill with no embedded raster, which never exhibited the bug.
 */
async function renderTransformedArtwork(
  sketchDataUrl: string,
  geometry: PendantGeometry,
  transform: PendantTransform,
): Promise<{ png: Buffer; width: number; height: number }> {
  const { buffer } = decodeDataUrl(sketchDataUrl);
  const meta = await sharp(buffer).metadata();
  const imageWidth = meta.width ?? 0;
  const imageHeight = meta.height ?? 0;
  if (!imageWidth || !imageHeight) {
    throw new Error('Could not read the master sketch dimensions.');
  }

  const { cx, cy, scale } = coverFit(imageWidth, imageHeight, geometry.engravingArea, transform);

  const canvasWidth = Math.round(PENDANT_VIEWBOX.width * RASTER_SCALE);
  const canvasHeight = Math.round(PENDANT_VIEWBOX.height * RASTER_SCALE);

  // Resize to the exact target pixel size implied by the cover-fit scale,
  // in canvas (raster) pixels.
  const targetWidth = Math.max(1, Math.round(imageWidth * scale * RASTER_SCALE));
  const targetHeight = Math.max(1, Math.round(imageHeight * scale * RASTER_SCALE));

  let artwork = sharp(buffer).resize(targetWidth, targetHeight, { fit: 'fill' });
  if (transform.rotation % 360 !== 0) {
    // sharp rotates around the image's own center and grows the canvas to
    // fit the rotated bounding box — exactly the semantics needed here, and
    // why the composite position below is computed *after* this step, from
    // whatever the rotated buffer's own dimensions turn out to be.
    artwork = artwork.rotate(transform.rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
  }
  let artworkBuffer = await artwork.png().toBuffer();
  const artworkMeta = await sharp(artworkBuffer).metadata();
  let artworkWidth = artworkMeta.width ?? targetWidth;
  let artworkHeight = artworkMeta.height ?? targetHeight;

  let left = Math.round(cx * RASTER_SCALE - artworkWidth / 2);
  let top = Math.round(cy * RASTER_SCALE - artworkHeight / 2);

  // "Cover" fit means the artwork is *meant* to overflow its target box —
  // the outer shape is what's supposed to crop that overflow. But for a
  // generous engraving area combined with a strongly elongated photo, the
  // overflow can exceed the *entire* canvas, and sharp's composite refuses
  // an overlay larger than its base rather than clipping it. So the crop
  // that would otherwise happen implicitly has to happen explicitly here:
  // extract just the region of the artwork that actually falls within the
  // canvas before handing it to composite.
  const visibleLeft = Math.max(0, -left);
  const visibleTop = Math.max(0, -top);
  const visibleWidth = Math.min(artworkWidth - visibleLeft, canvasWidth - Math.max(left, 0));
  const visibleHeight = Math.min(artworkHeight - visibleTop, canvasHeight - Math.max(top, 0));

  if (visibleWidth <= 0 || visibleHeight <= 0) {
    // The customer has panned the artwork entirely out of view. Not an
    // error — the resulting export is legitimately just an empty pendant.
    artworkBuffer = await sharp({
      create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    artworkWidth = 1;
    artworkHeight = 1;
    left = 0;
    top = 0;
  } else if (visibleWidth < artworkWidth || visibleHeight < artworkHeight) {
    artworkBuffer = await sharp(artworkBuffer)
      .extract({ left: visibleLeft, top: visibleTop, width: visibleWidth, height: visibleHeight })
      .png()
      .toBuffer();
    left = Math.max(left, 0);
    top = Math.max(top, 0);
  }

  const placed = await sharp({
    create: { width: canvasWidth, height: canvasHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: artworkBuffer, left, top }])
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Multiply alpha by the shape mask: this is the actual clip. Nothing here
  // depends on SVG image embedding, so the bug above cannot recur. For Edge
  // Cut inside Heart, `artworkClipPath` is a second mask (the traced
  // silhouette, already transformed into this same viewBox) multiplied in
  // as well — matching the two-clip `ctx.clip()` stack `paintPendant` uses
  // for the exact same case, so the artwork is confined to both the heart
  // and its own silhouette here too.
  const mask = await rasterizeShapeMask(geometry.outerPath, canvasWidth, canvasHeight);
  const clipMask = geometry.artworkClipPath
    ? await rasterizeShapeMask(geometry.artworkClipPath, canvasWidth, canvasHeight)
    : null;
  const pixels = placed.data;
  const channels = placed.info.channels;
  for (let i = 0, m = 0; i < pixels.length; i += channels, m++) {
    let coverage = mask[m];
    if (clipMask) coverage = Math.round((coverage * clipMask[m]) / 255);
    pixels[i + 3] = Math.round((pixels[i + 3] * coverage) / 255);
  }

  const png = await sharp(pixels, { raw: { width: canvasWidth, height: canvasHeight, channels } })
    .png({ compressionLevel: 9 })
    .toBuffer();

  return { png, width: canvasWidth, height: canvasHeight };
}

/** Trace the (white-flattened) engraving raster into a vector `<path>`. */
function tracePath(png: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    potraceTrace(png, POTRACE_OPTIONS, (error, _svg, instance) => {
      if (error) {
        reject(error);
        return;
      }
      try {
        const pathTag = instance.getPathTag('#000000');
        const match = /\sd="([^"]*)"/.exec(pathTag);
        resolve(match ? match[1] : '');
      } catch (innerError) {
        reject(innerError instanceof Error ? innerError : new Error(String(innerError)));
      }
    });
  });
}

export interface LaserExportInput {
  /** The masterSketch data URL — the one and only AI output, unchanged. */
  sketch: string;
  shape: ShapeId;
  material: MaterialId;
  transform: PendantTransform;
  /** The category's or shape's own engraving box — same value the client used to build its preview. */
  engravingArea: { x: number; y: number; width: number; height: number };
  designType: DesignType;
  edgeCutStyle: EdgeCutStyle;
  /** The traced silhouette, computed once client-side — required when `designType` is 'edge-cut'. */
  contour: SilhouetteContour | null;
  /** Physical width of the exported pendant outline, in millimeters. */
  widthMm?: number;
}

export interface LaserExportResult {
  svg: string;
  dxf: string;
  /** Transparent PNG of the same transformed, shape-clipped artwork, as a data URL. */
  pngDataUrl: string;
  widthMm: number;
  heightMm: number;
}

export async function buildLaserExportAssets(input: LaserExportInput): Promise<LaserExportResult> {
  const geometry = resolvePendantGeometry({
    designType: input.designType,
    shape: input.shape,
    edgeCutStyle: input.edgeCutStyle,
    engravingArea: input.engravingArea,
    contour: input.contour,
    transform: input.transform,
  });
  const widthMm = input.widthMm ?? DEFAULT_WIDTH_MM;
  const mmPerUnit = widthMm / PENDANT_VIEWBOX.width;
  const heightMm = PENDANT_VIEWBOX.height * mmPerUnit;

  const { png: artworkPng } = await renderTransformedArtwork(input.sketch, geometry, input.transform);

  const pngDataUrl = `data:image/png;base64,${artworkPng.toString('base64')}`;

  // Potrace needs a flat background to threshold against — the direct PNG
  // deliverable above stays transparent, this flattened copy exists only to
  // feed the tracer.
  const forTracing = await sharp(artworkPng).flatten({ background: '#ffffff' }).png().toBuffer();
  const tracedD = await tracePath(forTracing);

  // Bring the traced path from raster-pixel space back into viewBox units so
  // it lines up with the shape outline, which is natively defined there.
  const unitsPerRasterPx = 1 / RASTER_SCALE;

  const materialLabel = PENDANT_MATERIALS[input.material].label;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Custom Pendant Design — ${escapeAttr(geometry.label)} (${escapeAttr(materialLabel)})
     Generated once from an AI sketch, then only ever transformed and traced —
     see lib/laser-export.ts. Sized to ${widthMm}mm wide; rescale freely in
     your laser software. -->
<svg xmlns="http://www.w3.org/2000/svg" width="${widthMm}mm" height="${heightMm.toFixed(3)}mm" viewBox="0 0 ${PENDANT_VIEWBOX.width} ${PENDANT_VIEWBOX.height}">
  <g id="cut" fill="none" stroke="#ff0000" stroke-width="0.3">
    <path d="${escapeAttr(geometry.outerPath)}"/>
  </g>
  <g id="engrave" fill="#000000" stroke="none" transform="scale(${unitsPerRasterPx})">
    <path d="${tracedD}"/>
  </g>
</svg>`;

  // DXF: everything reduced to polylines/circles, in millimeters. This is
  // the one deliverable that must be flattened — DXF's LWPOLYLINE has no
  // curve primitive of its own.
  const scalePoint = (p: Point): Point => ({ x: p.x * mmPerUnit, y: p.y * mmPerUnit });

  const outlinePolylines = flattenPath(geometry.outerPath).map((line) => line.map(scalePoint));
  const engravingRasterUnits = flattenPath(tracedD);
  const engravingPolylines = engravingRasterUnits.map((line) =>
    line.map((p) => scalePoint({ x: p.x * unitsPerRasterPx, y: p.y * unitsPerRasterPx })),
  );

  const dxfPolylines: DxfPolylineSpec[] = [
    ...outlinePolylines.map((points) => ({ points, layer: 'CUT' as const, closed: true })),
    ...engravingPolylines.map((points) => ({ points, layer: 'ENGRAVE' as const, closed: true })),
  ];
  const dxfCircles: DxfCircleSpec[] = [];

  const dxf = buildDxf(dxfPolylines, dxfCircles);

  return { svg, dxf, pngDataUrl, widthMm, heightMm };
}
