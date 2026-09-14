'use client';

/**
 * Manufacturing files: SVG, DXF and Rhino 3DM for the cutter and the CAD
 * operator. Built from the bare artwork (traced via potrace) and the cut
 * outline, not from a picture of a metal pendant — which genuinely needs
 * the server (vectorization, .3dm writing). See lib/laser-export.ts. Product
 * images live in components/MockupPanel.tsx and components/DownloadPanel.tsx.
 *
 * The server resolves the *same* geometry (lib/pendant-geometry.ts) from the
 * same design fields this component is handed, so an export can never show
 * a different boundary than the preview. For Silhouette Cut, `contour`
 * (traced once, client-side, by lib/edge-cut-contour.ts) is sent as plain
 * data rather than recomputed there — see the comment on `/api/export-laser`.
 */

import * as React from 'react';
import { downloadFile } from '@/lib/download';
import type { MaterialId, RimColorId } from '@/lib/materials';
import { PENDANT_CATEGORIES, type CategoryId } from '@/lib/pendant-categories';
import type { DesignType, SilhouetteContour } from '@/lib/pendant-geometry';
import { PENDANT_SHAPES, type PendantTransform, type ShapeId } from '@/lib/pendant-shapes';

interface VectorAssets {
  svg: string;
  dxf: string;
  threeDmBase64: string;
  widthMm: number;
  heightMm: number;
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

export function ExportPanel({
  sketch,
  shape,
  material,
  category,
  designType,
  contour,
  rimColor,
  transform,
}: {
  sketch: string;
  shape: ShapeId;
  material: MaterialId;
  category: CategoryId;
  designType: DesignType;
  contour: SilhouetteContour | null;
  rimColor: RimColorId;
  transform: PendantTransform;
}) {
  const engravingArea = PENDANT_CATEGORIES[category].engravingArea;

  const [status, setStatus] = React.useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = React.useState<string | null>(null);
  const [assets, setAssets] = React.useState<VectorAssets | null>(null);
  const requestKeyRef = React.useRef<string | null>(null);

  const currentKey = JSON.stringify({ shape, transform, designType, contour, category });

  const prepare = async () => {
    const key = currentKey;
    requestKeyRef.current = key;
    setStatus('loading');
    setError(null);
    try {
      const response = await fetch('/api/export-laser', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sketch, shape, material, transform, engravingArea, designType, contour, rimColor, category }),
      });
      const body = (await response.json().catch(() => null)) as
        | ({ success: true } & VectorAssets)
        | { success: false; error: string }
        | null;
      if (requestKeyRef.current !== key) return; // superseded by a newer request
      if (!body || !response.ok || !body.success) {
        setError(!body || !('error' in body) ? 'We couldn\'t prepare the files.' : body.error);
        setStatus('error');
        return;
      }
      setAssets(body);
      setStatus('idle');
    } catch {
      if (requestKeyRef.current !== key) return;
      setError('We couldn\'t connect. Check your internet and try again.');
      setStatus('error');
    }
  };

  // Prepared files are tied to a specific design — once any of it changes,
  // clear them rather than let them go stale (compare against state, not a
  // ref: a ref read during render has no consistency guarantee).
  const [preparedKey, setPreparedKey] = React.useState(currentKey);
  if (currentKey !== preparedKey) {
    setPreparedKey(currentKey);
    if (assets) setAssets(null);
  }

  const silhouettePending = designType === 'edge-cut' && !contour;
  const baseName = `pendant-${designType === 'edge-cut' ? 'silhouette' : PENDANT_SHAPES[shape].id}`;

  const fileButton = 'inline-flex items-center justify-center gap-2 rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50';

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-slate-500">
        Files for making the pendant, measured in millimetres. The red line is where the metal gets cut and the black
        is what gets engraved. Use the DXF for the laser cutter, the 3DM for Rhino, and the SVG for anything else.
      </p>
      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
          {error}
        </div>
      )}
      {!assets ? (
        <button
          type="button"
          onClick={prepare}
          disabled={status === 'loading' || silhouettePending}
          className="inline-flex items-center justify-center gap-2 self-start rounded-full border border-slate-300 bg-white px-5 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status === 'loading' ? 'Getting files ready…' : 'Get production files'}
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => downloadFile(`${baseName}.3dm`, base64ToBlob(assets.threeDmBase64, 'application/octet-stream'))} className={fileButton}>
            Download 3DM (Rhino)
          </button>
          <button type="button" onClick={() => downloadFile(`${baseName}.dxf`, assets.dxf, 'application/dxf')} className={fileButton}>
            Download DXF (laser cutter)
          </button>
          <button type="button" onClick={() => downloadFile(`${baseName}.svg`, assets.svg, 'image/svg+xml')} className={fileButton}>
            Download SVG
          </button>
          <span className="text-xs text-slate-400">
            {assets.widthMm}mm × {assets.heightMm.toFixed(0)}mm. You can resize it in your software.
          </span>
        </div>
      )}
    </div>
  );
}
