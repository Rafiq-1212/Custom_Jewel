'use client';

/**
 * The production "cut layout" view — the same picture the client's own
 * reference files show: the engraving artwork in black, and the cut
 * boundary (with the hanging ring and its hole, for Silhouette Cut) as a
 * thin red line, on white. It is drawn from exactly the geometry the
 * SVG/DXF/3DM export uses (lib/pendant-geometry.ts), so what's on screen is
 * what the laser will cut and engrave. No metal rendering, no AI.
 */

import * as React from 'react';
import { downloadFile } from '@/lib/download';
import { PENDANT_CATEGORIES, type CategoryId } from '@/lib/pendant-categories';
import { placeArtwork, resolvePendantGeometry, type DesignType, type SilhouetteContour } from '@/lib/pendant-geometry';
import { PENDANT_VIEWBOX, type PendantTransform, type ShapeId } from '@/lib/pendant-shapes';

/** Same red the exported SVG uses for its CUT layer. */
const CUT_COLOUR = '#ff0000';

interface CutLayoutInput {
  sketch: string;
  shape: ShapeId;
  category: CategoryId;
  designType: DesignType;
  contour: SilhouetteContour | null;
  transform: PendantTransform;
}

function decodeImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not decode the sketch image.'));
    image.src = src;
  });
}

function paintCutLayout(canvas: HTMLCanvasElement, image: HTMLImageElement, input: CutLayoutInput, size: number, pixelRatio: number) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const geometry = resolvePendantGeometry({
    designType: input.designType,
    shape: input.shape,
    engravingArea: PENDANT_CATEGORIES[input.category].engravingArea,
    contour: input.contour,
    transform: input.transform,
  });

  const displayHeight = size * (PENDANT_VIEWBOX.height / PENDANT_VIEWBOX.width);
  canvas.width = Math.round(size * pixelRatio);
  canvas.height = Math.round(displayHeight * pixelRatio);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${displayHeight}px`;

  const scale = canvas.width / PENDANT_VIEWBOX.width;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, PENDANT_VIEWBOX.width, PENDANT_VIEWBOX.height);

  const cutPath = new Path2D(geometry.outerPath);

  // Artwork in its own black, clipped to the metal — an engraving can't
  // exist outside the cut piece.
  ctx.save();
  ctx.clip(cutPath, 'evenodd');
  const { cx, cy, scale: artScale } = placeArtwork(geometry, image.naturalWidth, image.naturalHeight, input.transform);
  ctx.translate(cx, cy);
  ctx.rotate((input.transform.rotation * Math.PI) / 180);
  ctx.scale(artScale, artScale);
  ctx.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);
  ctx.restore();

  // The cut line: hairline red, like the export's CUT layer.
  ctx.strokeStyle = CUT_COLOUR;
  ctx.lineWidth = 0.35;
  ctx.lineJoin = 'round';
  ctx.stroke(cutPath);
}

/** Export-resolution PNG of the cut layout, via the same paint routine as the on-screen view. */
export async function renderCutLayoutPngBlob(input: CutLayoutInput, size = 1600): Promise<Blob> {
  const image = await decodeImage(input.sketch);
  const canvas = document.createElement('canvas');
  paintCutLayout(canvas, image, input, size, 1);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Canvas could not be exported to PNG.'))), 'image/png');
  });
}

export function CutLayoutPreview({ size = 280, ...input }: CutLayoutInput & { size?: number }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = React.useState<'idle' | 'loading' | 'error'>('idle');
  const { sketch, shape, category, designType, contour, transform } = input;

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    decodeImage(sketch).then((image) => {
      if (cancelled) return;
      paintCutLayout(canvas, image, { sketch, shape, category, designType, contour, transform }, size, Math.min(window.devicePixelRatio || 1, 2));
    });
    return () => {
      cancelled = true;
    };
  }, [sketch, shape, category, designType, contour, transform, size]);

  const pending = designType === 'edge-cut' && !contour;

  const download = async () => {
    setStatus('loading');
    try {
      downloadFile('cut-layout.png', await renderCutLayoutPngBlob(input));
      setStatus('idle');
    } catch {
      setStatus('error');
    }
  };

  return (
    <div className="flex flex-col items-center gap-3">
      <canvas ref={canvasRef} role="img" aria-label="Cut layout: artwork with red cut outline" className="rounded-xl border border-slate-200 bg-white" />
      <p className="max-w-sm text-center text-xs text-slate-500">
        Production layout — black is engraved, the red line is the cut{designType === 'edge-cut' ? ', including the hanging ring and its hole' : ''}. Exactly what the SVG / DXF / 3DM contain.
      </p>
      {status === 'error' && (
        <p role="alert" className="text-xs text-red-600">
          Unable to prepare the image. Please try again.
        </p>
      )}
      <button
        type="button"
        onClick={download}
        disabled={status === 'loading' || pending}
        className="inline-flex items-center justify-center rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {status === 'loading' ? 'Preparing…' : 'Download cut layout (PNG)'}
      </button>
    </div>
  );
}
