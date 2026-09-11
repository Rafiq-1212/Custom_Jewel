'use client';

/**
 * Traces the Free Edge Cut boundary from remove.bg's own alpha mask — the
 * one contour source in this app backed by a paid external API, which is
 * exactly why it's scoped as narrowly as possible: only Edge Cut → Free Edge
 * Cut uses this module. Standard Pendant, Edge Cut inside Heart, Bust with
 * Base and Silhouette Band never call it (they use lib/photo-silhouette.ts
 * or lib/edge-cut-contour.ts, both free and local).
 *
 * No second AI call, and no re-upload of the customer's photo: this sends
 * the EXISTING Gemini sketch (masterSketch) to the server
 * (/api/edge-cut/remove-background, which holds REMOVE_BG_API_KEY and is
 * the only thing that ever talks to remove.bg), gets back a transparent PNG,
 * and traces its alpha channel through the exact same mask-cleaning
 * pipeline every other silhouette source in this app already shares
 * (lib/silhouette-geometry.ts) — so the result is a `SilhouetteContour`
 * indistinguishable, to every consumer downstream (lib/pendant-geometry.ts,
 * paintPendant, the PNG/SVG/DXF export), from one traced locally. Nothing
 * past this function's return value needs to know remove.bg was involved.
 *
 * Caching/call-count discipline lives in the caller (app/page.tsx): this
 * function itself is called at most once per distinct `masterSketch`, only
 * when the customer actually selects Free Edge Cut — never on a zoom/
 * rotate/position/material change, and never speculatively before that.
 */

import type { SilhouetteContour } from './pendant-geometry';
import { closeToSingleComponent, maskToSmoothContour } from './silhouette-geometry';

const MAX_ANALYSIS_DIM = 450;
const ALPHA_THRESHOLD = 24;

function decodeImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not decode the Free Edge Cut result.'));
    image.src = src;
  });
}

export async function extractRemoveBgContour(masterSketch: string): Promise<SilhouetteContour> {
  const response = await fetch('/api/edge-cut/remove-background', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sketch: masterSketch }),
    cache: 'no-store',
  });
  const body = (await response.json().catch(() => null)) as
    | { success: true; image: string }
    | { success: false; error: string }
    | null;

  if (!body || !response.ok || !body.success) {
    throw new Error(!body || !('error' in body) ? 'Unable to create Free Edge Cut. Please try again.' : body.error);
  }

  const image = await decodeImage(body.image);
  const naturalWidth = image.naturalWidth;
  const naturalHeight = image.naturalHeight;
  if (!naturalWidth || !naturalHeight) {
    throw new Error('Could not read the Free Edge Cut result.');
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

  // remove.bg's own alpha is already a real subject cutout (unlike the
  // sparse-ink alpha lib/edge-cut-contour.ts has to bridge from scratch) —
  // still run it through the same adaptive closing used for a locally-
  // segmented photo, since a matte edge can have the same kind of small
  // real-world holes/gaps (hair strands, a soft/anti-aliased boundary) that
  // would otherwise fragment the traced silhouette.
  mask = closeToSingleComponent(mask, analysisWidth, analysisHeight);

  if (mask.every((v) => v === 0)) {
    throw new Error('Could not detect a subject in this sketch.');
  }

  const smoothed = maskToSmoothContour(mask, analysisWidth, analysisHeight);
  if (!smoothed) {
    throw new Error('Could not trace a Free Edge Cut boundary from this sketch.');
  }

  const scale = naturalWidth / analysisWidth;
  const points = smoothed.map((p) => ({
    x: p.x * scale - naturalWidth / 2,
    y: p.y * scale - naturalHeight / 2,
  }));

  // No ring/hole here: this parked path predates the integrated hanging ring.
  return { points, holes: [], imageWidth: naturalWidth, imageHeight: naturalHeight };
}
