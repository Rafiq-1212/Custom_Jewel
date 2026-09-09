'use client';

/**
 * Export section: a PNG that's pixel-identical to the live preview, plus
 * vector files for an actual laser cutter.
 *
 * These are two genuinely different kinds of file, built two different ways,
 * on purpose:
 *
 *   PNG   — the full pendant exactly as shown on screen (metal, bail,
 *           engraving), transparent outside the shape. Rendered by calling
 *           `renderPendantPngBlob`, which runs the *same* `paintPendant`
 *           function the on-screen canvas uses — not a second
 *           implementation, so it cannot show a different shape, crop, scale
 *           or position than the preview. Entirely client-side; no network
 *           call, no AI.
 *
 *   SVG/DXF — real vector files for a laser cutter's cut and engrave
 *           toolpaths. A laser doesn't care what "gold" looks like, so these
 *           are built from the bare artwork (traced via potrace), not a
 *           picture of a metal pendant — genuinely different content,
 *           genuinely needing the server (vectorization). See
 *           lib/laser-export.ts.
 *
 * Both paths — client PNG and server SVG/DXF — resolve the *same* geometry
 * (lib/pendant-geometry.ts's `resolvePendantGeometry`) from the same
 * `designType`/`shape`/`edgeCutStyle`/`contour` this component is handed, so
 * an Edge Cut export can never show a different boundary than the preview.
 * For Edge Cut, `contour` (traced once, client-side, by
 * lib/edge-cut-contour.ts) is sent to the server as plain data rather than
 * recomputed there — see the comment on `/api/export-laser` for why.
 */

import * as React from 'react';
import { renderPendantPngBlob } from '@/components/PendantPreview';
import type { CategoryId } from '@/lib/pendant-categories';
import { PENDANT_CATEGORIES } from '@/lib/pendant-categories';
import type { MaterialId } from '@/lib/materials';
import type { DesignType, EdgeCutStyle, SilhouetteContour } from '@/lib/pendant-geometry';
import { PENDANT_SHAPES, type PendantTransform, type ShapeId } from '@/lib/pendant-shapes';

interface VectorAssets {
  svg: string;
  dxf: string;
  widthMm: number;
  heightMm: number;
}

function download(filename: string, content: string | Blob, mimeType?: string): void {
  const blob = typeof content === 'string' ? new Blob([content], { type: mimeType }) : content;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function ExportPanel({
  sketch,
  shape,
  material,
  category,
  designType = 'standard',
  edgeCutStyle = 'free',
  contour = null,
  transform,
}: {
  sketch: string;
  shape: ShapeId;
  material: MaterialId;
  category?: CategoryId;
  designType?: DesignType;
  edgeCutStyle?: EdgeCutStyle;
  contour?: SilhouetteContour | null;
  transform: PendantTransform;
}) {
  const engravingArea = category ? PENDANT_CATEGORIES[category].engravingArea : PENDANT_SHAPES[shape].engravingArea;

  const [pngStatus, setPngStatus] = React.useState<'idle' | 'loading' | 'error'>('idle');
  const [pngError, setPngError] = React.useState<string | null>(null);

  const downloadPng = React.useCallback(async () => {
    setPngStatus('loading');
    setPngError(null);
    try {
      const blob = await renderPendantPngBlob({
        sketch,
        shape,
        material,
        category,
        designType,
        edgeCutStyle,
        contour,
        transform,
      });
      download(`pendant-${shape}-${material}.png`, blob);
      setPngStatus('idle');
    } catch {
      setPngError('Unable to render the pendant image. Please try again.');
      setPngStatus('error');
    }
  }, [sketch, shape, material, category, designType, edgeCutStyle, contour, transform]);

  const [vectorStatus, setVectorStatus] = React.useState<'idle' | 'loading' | 'error'>('idle');
  const [vectorError, setVectorError] = React.useState<string | null>(null);
  const [assets, setAssets] = React.useState<VectorAssets | null>(null);
  const requestKeyRef = React.useRef<string | null>(null);

  const currentKey = JSON.stringify({ shape, material, transform, designType, edgeCutStyle, contour });

  const prepareVectors = React.useCallback(async () => {
    const key = currentKey;
    requestKeyRef.current = key;
    setVectorStatus('loading');
    setVectorError(null);

    try {
      const response = await fetch('/api/export-laser', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sketch,
          shape,
          material,
          transform,
          engravingArea,
          designType,
          edgeCutStyle,
          contour,
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | ({ success: true } & VectorAssets)
        | { success: false; error: string }
        | null;

      if (requestKeyRef.current !== key) return; // superseded by a newer request

      if (!body || !response.ok || !body.success) {
        setVectorError(!body || !('error' in body) ? 'Unable to prepare the export.' : body.error);
        setVectorStatus('error');
        return;
      }

      setAssets(body);
      setVectorStatus('idle');
    } catch {
      if (requestKeyRef.current !== key) return;
      setVectorError('Unable to reach the export service. Please check your connection and try again.');
      setVectorStatus('error');
    }
  }, [currentKey, sketch, shape, material, transform, engravingArea, designType, edgeCutStyle, contour]);

  // Prepared vector files are tied to a specific design configuration — once
  // any of it changes, clear them rather than let them go stale. React's own
  // documented pattern for resetting state when a derived value changes:
  // compare against state, not a ref (a ref read during render has no
  // consistency guarantee under concurrent rendering).
  const [preparedKey, setPreparedKey] = React.useState(currentKey);
  if (currentKey !== preparedKey) {
    setPreparedKey(currentKey);
    if (assets) setAssets(null);
  }

  const edgeCutPending = designType === 'edge-cut' && !contour;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <p className="text-xs text-slate-500">
          The exact pendant shown above — same shape, metal, crop and adjustments — as a transparent PNG.
        </p>
        {pngError && (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
            {pngError}
          </div>
        )}
        <button
          type="button"
          onClick={downloadPng}
          disabled={pngStatus === 'loading' || edgeCutPending}
          className="inline-flex items-center justify-center gap-2 self-start rounded-full border border-slate-300 bg-white px-5 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pngStatus === 'loading' ? 'Rendering…' : 'Download PNG (transparent)'}
        </button>
      </div>

      <div className="flex flex-col gap-2 border-t border-slate-100 pt-5">
        <p className="text-xs text-slate-500">
          Vector files for an actual laser cutter — the engraving traced to real curves, generated once from
          the current design, metal and adjustments. No additional AI calls.
        </p>
        {vectorError && (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
            {vectorError}
          </div>
        )}
        {!assets ? (
          <button
            type="button"
            onClick={prepareVectors}
            disabled={vectorStatus === 'loading' || edgeCutPending}
            className="inline-flex items-center justify-center gap-2 self-start rounded-full border border-slate-300 bg-white px-5 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {vectorStatus === 'loading' ? 'Preparing files…' : 'Prepare laser-cutting files'}
          </button>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => download(`pendant-${shape}.svg`, assets.svg, 'image/svg+xml')}
              className="inline-flex items-center justify-center gap-2 rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
            >
              Download SVG (vector)
            </button>
            <button
              type="button"
              onClick={() => download(`pendant-${shape}.dxf`, assets.dxf, 'application/dxf')}
              className="inline-flex items-center justify-center gap-2 rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
            >
              Download DXF (laser cutter)
            </button>
            <span className="text-xs text-slate-400">
              {assets.widthMm}mm × {assets.heightMm.toFixed(0)}mm — rescale freely in your laser software
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
