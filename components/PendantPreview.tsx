'use client';

/**
 * Renders `sketch` inside `shape`, in `material`, with the given `transform`.
 *
 * This component makes zero network calls and never touches the AI. It is
 * pure canvas compositing, along one of two genuinely different rendering
 * paths (`paintDimensionalPendant` vs `paintFlatArtwork` below), chosen by
 * `geometry.isFlatArtwork`:
 *
 *   Standard Pendant — a dimensional metal plate: gradient fill, studio
 *   sheen, the sketch drawn with an emboss pass + `multiply` blend so black
 *   linework reads as an engraved groove rather than a pasted sticker, and a
 *   soft edge bevel. "Three-dimensional" here means a convincing *2D
 *   illusion* of depth, not real 3D geometry — there is no 3D model anywhere
 *   in this app.
 *
 *   Edge Cut (every style) — flat, material-tinted artwork only: the sketch
 *   itself, recoloured gold or silver, clipped to the cut boundary. No
 *   plate, no gradient, no sheen, no shadow, no embossed groove, no
 *   decorative rim — a customer-supplied reference made clear this should
 *   look like a clean cutout of the artwork, not a rendered piece of
 *   jewellery.
 *
 * Both paths share the same clip boundary (`geometry.outerPath` — a
 * catalogue shape for Standard, a traced silhouette for Edge Cut) and the
 * same `transform`, so Zoom/Rotate/Position always move the artwork and its
 * boundary in lockstep regardless of which path is drawing them.
 *
 * Reusable by design: the compare-finishes row is just two of these mounted
 * with different `material` props and the same `sketch`/`shape`/`transform`.
 */

import * as React from 'react';
import { PENDANT_MATERIALS, type MaterialId, type PendantMaterial } from '@/lib/materials';
import { PENDANT_CATEGORIES, type CategoryId } from '@/lib/pendant-categories';
import {
  coverFit,
  resolvePendantGeometry,
  type DesignType,
  type EdgeCutStyle,
  type PendantGeometry,
  type SilhouetteContour,
} from '@/lib/pendant-geometry';
import { PENDANT_SHAPES, PENDANT_VIEWBOX, type PendantTransform, type ShapeId } from '@/lib/pendant-shapes';

const GRADIENT_STOPS = [0, 0.24, 0.46, 0.68, 1] as const;

function buildMetalGradient(
  ctx: CanvasRenderingContext2D,
  material: PendantMaterial,
): CanvasGradient {
  // A fixed diagonal across the whole plate, independent of shape: real
  // studio lighting comes from one consistent direction regardless of the
  // silhouette it's falling on.
  const gradient = ctx.createLinearGradient(10, 15, 90, 110);
  material.gradient.forEach((colour, i) => gradient.addColorStop(GRADIENT_STOPS[i], colour));
  return gradient;
}

/**
 * A copy of the sketch's own ink recoloured to `color`, alpha-matched to the
 * original (built once via `source-in` onto a filled rect of that color) —
 * used both for the dimensional pendant's emboss highlight (always white)
 * and for flat Edge Cut artwork's material tint (gold or silver). Cached per
 * decoded `<img>` element *and* per color: the on-screen preview re-paints on
 * every zoom/rotate/pan tick but never decodes a new image or changes
 * material for those, so neither must be rebuilt every frame.
 */
const tintedInkMaskCache = new WeakMap<HTMLImageElement, Map<string, HTMLCanvasElement>>();

function getTintedInkMask(sketchImage: HTMLImageElement, color: string): HTMLCanvasElement {
  let byColor = tintedInkMaskCache.get(sketchImage);
  if (!byColor) {
    byColor = new Map();
    tintedInkMaskCache.set(sketchImage, byColor);
  }
  const cached = byColor.get(color);
  if (cached) return cached;

  const mask = document.createElement('canvas');
  mask.width = sketchImage.naturalWidth;
  mask.height = sketchImage.naturalHeight;
  const maskCtx = mask.getContext('2d');
  if (maskCtx) {
    maskCtx.drawImage(sketchImage, 0, 0);
    maskCtx.globalCompositeOperation = 'source-in';
    maskCtx.fillStyle = color;
    maskCtx.fillRect(0, 0, mask.width, mask.height);
  }
  byColor.set(color, mask);
  return mask;
}

/**
 * Standard Pendant's look: a dimensional metal plate — gradient fill,
 * studio sheen, an embossed/engraved-groove artwork pass, a soft edge
 * bevel, and an optional decorative rim. This is the original `paintPendant`
 * body, just given its own name once a second, genuinely different
 * rendering path (`paintFlatArtwork` below) needed to exist alongside it.
 */
function paintDimensionalPendant(
  ctx: CanvasRenderingContext2D,
  sketchImage: HTMLImageElement,
  geometry: PendantGeometry,
  material: MaterialId,
  transform: PendantTransform,
): void {
  const materialDef = PENDANT_MATERIALS[material];
  const shapePath = new Path2D(geometry.outerPath);
  const metalGradient = buildMetalGradient(ctx, materialDef);

  // Plate, with a soft drop shadow for depth.
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 1.5;
  ctx.fillStyle = metalGradient;
  ctx.fill(shapePath);
  ctx.restore();

  // Studio sheen.
  ctx.save();
  ctx.clip(shapePath);
  const sheen = ctx.createRadialGradient(35, 45, 2, 35, 45, 55);
  sheen.addColorStop(0, 'rgba(255,255,255,0.55)');
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, PENDANT_VIEWBOX.width, PENDANT_VIEWBOX.height);
  ctx.restore();

  // The sketch, engraved. Multiply blend: transparent pixels read as "no
  // change" against the metal, black linework stays dark — the classic
  // etched-into-metal look.
  //
  // Clipped to the outer shape, plus — for Edge Cut inside Heart — a second,
  // additional clip to the traced silhouette (`ctx.clip()` intersects with
  // whatever clip region is already active, so both apply at once). Never
  // clipped to an inner rectangle: that was a real, previously-fixed bug
  // (see git history) — a hard rectangular cutoff independent of the image's
  // own content, visible at some zoom/pan combinations even though the
  // sketch itself has no visible background.
  //
  // `engravingArea` is only ever a *target box* for the cover-fit maths below
  // — where and how big to draw by default — never a clip boundary.
  const area = geometry.engravingArea;
  ctx.save();
  ctx.clip(shapePath);
  if (geometry.artworkClipPath) {
    ctx.clip(new Path2D(geometry.artworkClipPath));
  }

  const { cx, cy, scale: finalScale } = coverFit(
    sketchImage.naturalWidth,
    sketchImage.naturalHeight,
    area,
    transform,
  );
  const rotationRad = (transform.rotation * Math.PI) / 180;

  // Emboss: a faint white "shoulder" of the same artwork, offset toward the
  // same light direction as the sheen above, drawn with a lightening blend
  // *before* the dark engraving itself. A real engraved groove has one wall
  // that catches the light and a floor that falls into shadow — without
  // this the ink was reading as a flat sticker no matter how the metal
  // around it was shaded. Offset in fixed viewBox units (not scaled by
  // zoom) so the groove keeps one consistent physical width regardless of
  // how far the customer has zoomed the artwork in or out.
  const EMBOSS_OFFSET = 0.5;
  ctx.save();
  ctx.translate(cx - EMBOSS_OFFSET, cy - EMBOSS_OFFSET);
  ctx.rotate(rotationRad);
  ctx.scale(finalScale, finalScale);
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = 0.55;
  ctx.drawImage(
    getTintedInkMask(sketchImage, '#ffffff'),
    -sketchImage.naturalWidth / 2,
    -sketchImage.naturalHeight / 2,
  );
  ctx.restore();

  ctx.translate(cx, cy);
  ctx.rotate(rotationRad);
  ctx.scale(finalScale, finalScale);
  ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(sketchImage, -sketchImage.naturalWidth / 2, -sketchImage.naturalHeight / 2);
  ctx.restore();

  // Edge bevel: a soft inner shadow all around the boundary, plus a
  // directional highlight on the side facing the same light as the sheen —
  // so the boundary itself reads as a rounded, slightly-domed edge rather
  // than a flat cutout. Applies to every shape, including a traced
  // silhouette with no decorative rim: both strokes are clipped to the
  // *inside* of `shapePath`, so nothing is ever drawn outside it — this is
  // shading on the existing edge, never an added outline/halo/border.
  ctx.save();
  ctx.clip(shapePath);
  for (const [width, alpha] of [
    [4.5, 0.1],
    [3, 0.1],
    [1.6, 0.12],
  ] as const) {
    ctx.strokeStyle = `rgba(0,0,0,${alpha})`;
    ctx.lineWidth = width;
    ctx.stroke(shapePath);
  }
  ctx.translate(-1.1, -1.1);
  for (const [width, alpha] of [
    [2.2, 0.16],
    [1.1, 0.22],
  ] as const) {
    ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
    ctx.lineWidth = width;
    ctx.stroke(shapePath);
  }
  ctx.restore();

  // Rim, for definition against the page background — only for a real
  // catalogue outline (Standard, or Edge Cut inside Heart). A traced
  // silhouette (Free Edge Cut / Bust with Base / Silhouette Band) must not
  // get one: stroking an extra outline around an already-organic contour is
  // exactly the artificial border/halo customers have explicitly asked this
  // app not to add — the traced boundary itself is the cutting edge, full
  // stop. See `hasDecorativeRim` on `PendantGeometry`.
  if (geometry.hasDecorativeRim) {
    ctx.save();
    ctx.strokeStyle = materialDef.rim;
    ctx.lineWidth = 1.1;
    ctx.stroke(shapePath);
    ctx.restore();
  }
}

/**
 * Edge Cut's look (every style: Free, Heart, Bust with Base, Silhouette
 * Band): the flat artwork itself, tinted to the chosen material, clipped to
 * the cut boundary — no metal plate, no gradient, no sheen, no shadow, no
 * embossed groove, no decorative rim. This exists because a customer showed
 * a reference of exactly this look (a clean cutout of the sketch, not a
 * rendered piece of jewellery) and explicitly rejected the dimensional
 * rendering for Edge Cut; Standard Pendant is unaffected and keeps
 * `paintDimensionalPendant` above.
 */
function paintFlatArtwork(
  ctx: CanvasRenderingContext2D,
  sketchImage: HTMLImageElement,
  geometry: PendantGeometry,
  material: MaterialId,
  transform: PendantTransform,
): void {
  const materialDef = PENDANT_MATERIALS[material];
  const shapePath = new Path2D(geometry.outerPath);

  // Clipped to the cut boundary — nothing outside it, and nothing drawn
  // *along* it either (no rim/stroke/halo): the artwork's own edge, wherever
  // the clip cuts it off, is the entire visual boundary.
  ctx.save();
  ctx.clip(shapePath);
  if (geometry.artworkClipPath) {
    ctx.clip(new Path2D(geometry.artworkClipPath));
  }

  // Bust with Base / Silhouette Band: the boundary extends past the ink on
  // purpose (a solid base, a solid border), so those regions need *some*
  // pixels or the style is invisible. A single light, flat metal tone — no
  // gradient, sheen, shadow or rim — reads as the cut piece of metal the
  // base/band physically is, while the artwork stays flat on top of it.
  if (geometry.fillsBoundary) {
    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = materialDef.gradient[1];
    ctx.fill(shapePath);
    ctx.restore();
  }

  const area = geometry.engravingArea;
  const { cx, cy, scale: finalScale } = coverFit(
    sketchImage.naturalWidth,
    sketchImage.naturalHeight,
    area,
    transform,
  );

  ctx.translate(cx, cy);
  ctx.rotate((transform.rotation * Math.PI) / 180);
  ctx.scale(finalScale, finalScale);
  const artwork = materialDef.tintArtwork
    ? getTintedInkMask(sketchImage, materialDef.rim)
    : sketchImage;
  ctx.drawImage(artwork, -sketchImage.naturalWidth / 2, -sketchImage.naturalHeight / 2);
  ctx.restore();
}

/**
 * The single source of truth for turning a sketch + geometry + material +
 * transform into pixels. The on-screen `<PendantPreview>` calls this every
 * paint; `renderPendantPngBlob` below calls the exact same function at export
 * resolution for the "Download PNG" button. There is deliberately no second
 * implementation anywhere (previously the PNG export had one, server-side, in
 * `lib/laser-export.ts` — it re-derived the same clip/placement math in a
 * different language against a different rendering engine, and drifted from
 * what the preview actually showed). If this function's output is correct,
 * both the preview and the PNG export are correct, by construction.
 *
 * `geometry` (from `resolvePendantGeometry` in lib/pendant-geometry.ts) is
 * what decouples this function from any particular shape, *and* from which
 * of the two rendering paths above applies (`geometry.isFlatArtwork`) — for
 * a Standard pendant `outerPath` is a catalogue shape rendered as a
 * dimensional plate; for Edge Cut it's a traced silhouette (or the heart,
 * plus an `artworkClipPath`) rendered as flat, material-tinted artwork.
 */
export function paintPendant(
  canvas: HTMLCanvasElement,
  sketchImage: HTMLImageElement,
  geometry: PendantGeometry,
  material: MaterialId,
  transform: PendantTransform,
  size: number,
  /**
   * Device-pixel-ratio multiplier applied on top of `size`. Defaults to the
   * viewing browser's own ratio (capped at 2) for the on-screen preview.
   * `renderPendantPngBlob` passes `1` explicitly — for an export, `size` is
   * already the exact pixel width wanted in the downloaded file, and
   * multiplying it by whatever screen density the customer's device happens
   * to have would make the file's dimensions depend on their hardware.
   */
  pixelRatio: number = Math.min(window.devicePixelRatio || 1, 2),
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = pixelRatio;
  const displayWidth = size;
  const displayHeight = size * (PENDANT_VIEWBOX.height / PENDANT_VIEWBOX.width);

  canvas.width = Math.round(displayWidth * dpr);
  canvas.height = Math.round(displayHeight * dpr);
  canvas.style.width = `${displayWidth}px`;
  canvas.style.height = `${displayHeight}px`;

  const scale = (displayWidth * dpr) / PENDANT_VIEWBOX.width;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, PENDANT_VIEWBOX.width, PENDANT_VIEWBOX.height);

  if (geometry.isFlatArtwork) {
    paintFlatArtwork(ctx, sketchImage, geometry, material, transform);
  } else {
    paintDimensionalPendant(ctx, sketchImage, geometry, material, transform);
  }
}

function decodeImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not decode the sketch image.'));
    image.src = src;
  });
}

/** Print/export resolution is meaningfully higher than the on-screen preview size. */
const EXPORT_SIZE = 1600;

export interface RenderPendantPngOptions {
  sketch: string;
  shape: ShapeId;
  material: MaterialId;
  transform: PendantTransform;
  category?: CategoryId;
  designType?: DesignType;
  edgeCutStyle?: EdgeCutStyle;
  contour?: SilhouetteContour | null;
  /** Output width in pixels. Defaults to print/laser-reference quality. */
  size?: number;
}

/**
 * Render the pendant to a PNG `Blob`, at export resolution, via the exact
 * same `paintPendant` the live preview uses — so "Download PNG" can never
 * show a different shape, crop, scale, rotation or position than what the
 * customer is looking at on screen. Pure client-side canvas work: no network
 * call, no AI, and nothing server-side to keep in sync with this file.
 */
export async function renderPendantPngBlob(options: RenderPendantPngOptions): Promise<Blob> {
  const image = await decodeImage(options.sketch);

  const canvas = document.createElement('canvas');
  const engravingArea = options.category
    ? PENDANT_CATEGORIES[options.category].engravingArea
    : PENDANT_SHAPES[options.shape].engravingArea;

  const geometry = resolvePendantGeometry({
    designType: options.designType ?? 'standard',
    shape: options.shape,
    edgeCutStyle: options.edgeCutStyle ?? 'free',
    engravingArea,
    contour: options.contour ?? null,
    transform: options.transform,
  });

  // Reuse the real paint routine directly — see the comment on `paintPendant`
  // for why this must never be a second, independent implementation.
  // `pixelRatio: 1` because `size` here already *is* the target pixel width;
  // the live preview's own screen density has nothing to do with a file
  // being downloaded.
  paintPendant(canvas, image, geometry, options.material, options.transform, options.size ?? EXPORT_SIZE, 1);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Canvas could not be exported to PNG.'));
    }, 'image/png');
  });
}

export interface PendantPreviewProps {
  /** The one AI-generated sketch. Never regenerated by anything in this component. */
  sketch: string | null;
  shape: ShapeId;
  material: MaterialId;
  transform: PendantTransform;
  /**
   * Optional framing preset (Face / Couple / Family / ...). Purely a
   * different `engravingArea` target box — same shape silhouette, same
   * sketch, same everything else. Falls back to the shape's own box when
   * omitted, so this prop is optional for callers that don't use categories.
   */
  category?: CategoryId;
  /** Standard (catalogue shape) or Edge Cut. Defaults to Standard. */
  designType?: DesignType;
  /** Free silhouette boundary, or silhouette clipped inside a heart. Only used when `designType` is 'edge-cut'. */
  edgeCutStyle?: EdgeCutStyle;
  /** The traced silhouette for the current sketch — computed once by lib/edge-cut-contour.ts and cached by the caller, `null` while unavailable. Ignored for Standard pendants. */
  contour?: SilhouetteContour | null;
  /** Display width in CSS pixels; height follows the fixed pendant viewBox. */
  size?: number;
  className?: string;
}

export function PendantPreview({
  sketch,
  shape,
  material,
  transform,
  category,
  designType = 'standard',
  edgeCutStyle = 'free',
  contour = null,
  size = 300,
  className,
}: PendantPreviewProps) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const frameRef = React.useRef<number | null>(null);
  // Decoded <img> keyed by its source string, so changing shape/material/
  // transform alone never re-decodes the image — only a genuinely new
  // `sketch` does. A ref, not state: the decode result feeds a canvas paint
  // directly and never needs to drive a re-render of its own.
  const decodedRef = React.useRef<{ src: string; image: HTMLImageElement } | null>(null);

  const geometry = React.useMemo(() => {
    const engravingArea = category ? PENDANT_CATEGORIES[category].engravingArea : PENDANT_SHAPES[shape].engravingArea;
    return resolvePendantGeometry({ designType, shape, edgeCutStyle, engravingArea, contour, transform });
  }, [category, shape, designType, edgeCutStyle, contour, transform]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !sketch) return;

    let cancelled = false;

    const schedulePaint = (sketchImage: HTMLImageElement) => {
      // Coalesce rapid slider drags into one paint per frame.
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = requestAnimationFrame(() => {
        paintPendant(canvas, sketchImage, geometry, material, transform, size);
      });
    };

    if (decodedRef.current?.src === sketch) {
      schedulePaint(decodedRef.current.image);
    } else {
      const image = new Image();
      image.onload = () => {
        if (cancelled) return;
        decodedRef.current = { src: sketch, image };
        schedulePaint(image);
      };
      image.src = sketch;
    }

    return () => {
      cancelled = true;
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [sketch, geometry, material, transform, size]);

  if (!sketch) return null;

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={`${PENDANT_MATERIALS[material].label} ${geometry.label} pendant preview`}
      className={className}
    />
  );
}
