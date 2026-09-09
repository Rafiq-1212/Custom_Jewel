'use client';

/**
 * Traces a clean, single, closed jewellery-style silhouette boundary out of
 * the existing `masterSketch` — never a second AI call, never the raw photo.
 * Runs once per generated sketch and is cached from then on; nothing about
 * switching design/shape/style or dragging the zoom/position/rotation
 * sliders ever calls this again.
 *
 * This is the *fallback* silhouette source: lib/photo-silhouette.ts (traced
 * from the original uploaded photo) is preferred whenever that photo is
 * still available in this session, because it produces a materially more
 * accurate subject outline. This module exists for the case it isn't — most
 * notably after a page reload, where only `masterSketch` survives in
 * sessionStorage (see lib/pendant-storage.ts; the raw photo is deliberately
 * never persisted) — so Free/Heart Edge Cut still work, just from a less
 * precise source.
 *
 * The master sketch is line art with a transparent background (see
 * lib/image-processing.ts) — only the ink strokes are opaque, so the raw
 * alpha mask is a sparse set of thin curves, not a filled blob. The pipeline
 * below is standard binary-image morphology (lib/silhouette-geometry.ts):
 *
 *   decode + downsample -> alpha threshold -> dilate (bridges stroke gaps,
 *   merges nearby subjects into one blob — structurally required to get a
 *   filled region out of sparse line art at all, not a stylistic margin) ->
 *   keep the largest connected component only -> trace, simplify, smooth ->
 *   map back into the sketch image's own local coordinate space, centered on
 *   the image's own center (the same convention
 *   `drawImage(img, -w/2, -h/2)` already uses), so `transformPoints` in
 *   lib/pendant-geometry.ts can carry it through whatever zoom/pan/rotation
 *   the customer applies afterward.
 */

import type { SilhouetteContour } from './pendant-geometry';
import { dilate, largestComponentMask, maskToSmoothContour } from './silhouette-geometry';

const MAX_ANALYSIS_DIM = 450;
const ALPHA_THRESHOLD = 24;

function decodeImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not decode the sketch image.'));
    image.src = src;
  });
}

export async function extractSilhouetteContour(sketchDataUrl: string): Promise<SilhouetteContour> {
  const image = await decodeImage(sketchDataUrl);
  const naturalWidth = image.naturalWidth;
  const naturalHeight = image.naturalHeight;
  if (!naturalWidth || !naturalHeight) {
    throw new Error('Could not read the sketch dimensions.');
  }

  const downscale = Math.min(1, MAX_ANALYSIS_DIM / Math.max(naturalWidth, naturalHeight));
  const analysisWidth = Math.max(1, Math.round(naturalWidth * downscale));
  const analysisHeight = Math.max(1, Math.round(naturalHeight * downscale));

  const canvas = document.createElement('canvas');
  canvas.width = analysisWidth;
  canvas.height = analysisHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas is not available in this browser.');
  ctx.drawImage(image, 0, 0, analysisWidth, analysisHeight);
  const { data } = ctx.getImageData(0, 0, analysisWidth, analysisHeight);

  let mask: Uint8Array = new Uint8Array(analysisWidth * analysisHeight);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    mask[p] = data[i + 3] >= ALPHA_THRESHOLD ? 1 : 0;
  }

  // This dilation is structural, not stylistic: the master sketch is sparse
  // line art (only the ink strokes are opaque), so without bridging those
  // strokes into a solid blob there is no filled region to trace a boundary
  // from at all. It is not an added margin/border around an already-solid
  // silhouette — compare lib/photo-silhouette.ts, whose mask is already
  // solid and therefore adds no such dilation for 'full'/'bust'. The cut
  // boundary must be the subjects' own contour, with no extra stroke, halo,
  // frame, rim, or padding beyond what bridging the ink actually requires.
  const bridgeRadius = Math.max(4, Math.round(Math.max(analysisWidth, analysisHeight) * 0.025));
  mask = dilate(mask, analysisWidth, analysisHeight, bridgeRadius);
  mask = largestComponentMask(mask, analysisWidth, analysisHeight);

  const smoothed = maskToSmoothContour(mask, analysisWidth, analysisHeight);
  if (!smoothed) {
    throw new Error('This sketch has no visible artwork to trace an edge-cut boundary from.');
  }

  const scale = naturalWidth / analysisWidth;
  const points = smoothed.map((p) => ({
    x: p.x * scale - naturalWidth / 2,
    y: p.y * scale - naturalHeight / 2,
  }));

  return { points, imageWidth: naturalWidth, imageHeight: naturalHeight };
}
