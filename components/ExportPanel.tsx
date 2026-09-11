'use client';

/**
 * Laser-cutting export: SVG and DXF vector files for an actual cutter's cut
 * and engrave toolpaths. A laser doesn't care what "gold" looks like, so
 * these are built from the bare artwork (traced via potrace), not a picture
 * of a metal pendant — which genuinely needs the server (vectorization). See
 * lib/laser-export.ts. PNG downloads of the rendered pendant live in
 * components/DownloadPanel.tsx instead.
 *
 * The server resolves the *same* geometry (lib/pendant-geometry.ts's
 * `resolvePendantGeometry`) from the same `designType`/`shape`/
 * `edgeCutStyle`/`contour` this component is handed, so an Edge Cut export
 * can never show a different boundary than the preview. For Edge Cut,
 * `contour` (traced once, client-side, by lib/edge-cut-contour.ts) is sent
 * to the server as plain data rather than recomputed there — see the comment
 * on `/api/export-laser` for why.
 */

import * as React from 'react';
import { downloadFile } from '@/lib/download';
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
              onClick={() => downloadFile(`pendant-${shape}.svg`, assets.svg, 'image/svg+xml')}
              className="inline-flex items-center justify-center gap-2 rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
            >
              Download SVG (vector)
            </button>
            <button
              type="button"
              onClick={() => downloadFile(`pendant-${shape}.dxf`, assets.dxf, 'application/dxf')}
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
