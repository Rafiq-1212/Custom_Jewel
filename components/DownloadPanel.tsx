'use client';

/**
 * "Pick one, download it" for the instant preview images: the bare
 * engraving sketch, or the live canvas preview of the pendant in either
 * metal. These are the fast, free renders — the photorealistic listing
 * images are components/MockupPanel.tsx.
 *
 * Every pendant option is rendered by the same `renderPendantPngBlob` /
 * `paintPendant` pair the live preview uses, with the current design and
 * adjustments, so what downloads is pixel-for-pixel what the thumbnail
 * shows. Client-side only: no network call, no AI.
 */

import * as React from 'react';
import { PendantPreview, renderPendantPngBlob } from '@/components/PendantPreview';
import { dataUrlToBlob, downloadFile } from '@/lib/download';
import { PENDANT_MATERIAL_LIST, type MaterialId, type RimColorId } from '@/lib/materials';
import { PENDANT_CATEGORIES, type CategoryId } from '@/lib/pendant-categories';
import { resolvePendantGeometry, type DesignType, type SilhouetteContour } from '@/lib/pendant-geometry';
import type { PendantTransform, ShapeId } from '@/lib/pendant-shapes';

/** `'sketch'` is the raw engraving artwork; anything else is a pendant in that metal. */
type OutputId = 'sketch' | MaterialId;

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function DownloadPanel({
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
  /** The metal currently selected in "Choose Metal" — the default pick here. */
  material: MaterialId;
  category: CategoryId;
  designType: DesignType;
  contour: SilhouetteContour | null;
  rimColor: RimColorId;
  transform: PendantTransform;
}) {
  // Follows the metal selection until the customer explicitly picks something
  // different down here.
  const [selected, setSelected] = React.useState<OutputId>(material);
  const [followedMaterial, setFollowedMaterial] = React.useState(material);
  if (material !== followedMaterial) {
    setFollowedMaterial(material);
    setSelected(material);
  }

  const [status, setStatus] = React.useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = React.useState<string | null>(null);

  const engravingArea = PENDANT_CATEGORIES[category].engravingArea;
  const designLabel = resolvePendantGeometry({ designType, shape, engravingArea, contour, transform }).label;

  const silhouettePending = designType === 'edge-cut' && !contour;
  const pendantUnavailable = silhouettePending && selected !== 'sketch';

  const download = async () => {
    setStatus('loading');
    setError(null);
    try {
      if (selected === 'sketch') {
        downloadFile('engraving-sketch.png', await dataUrlToBlob(sketch));
      } else {
        const blob = await renderPendantPngBlob({
          sketch,
          shape,
          material: selected,
          category,
          designType,
          contour,
          rimColor,
          transform,
        });
        downloadFile(`preview-${slug(designLabel)}-${selected}.png`, blob);
      }
      setStatus('idle');
    } catch {
      setError('Unable to prepare the image. Please try again.');
      setStatus('error');
    }
  };

  const optionClass = (isSelected: boolean) =>
    `flex flex-col items-center gap-2 rounded-xl border p-3 transition-colors ${
      isSelected ? 'border-slate-900 bg-slate-900/[0.04]' : 'border-slate-200 hover:border-slate-300'
    }`;

  return (
    <div className="flex flex-col gap-5">
      <p className="text-xs text-slate-500">
        Quick preview images — select one and download it as a transparent PNG. No AI calls.
      </p>

      <div role="radiogroup" aria-label="Output to download" className="grid grid-cols-3 gap-3">
        <button type="button" role="radio" aria-checked={selected === 'sketch'} onClick={() => setSelected('sketch')} className={optionClass(selected === 'sketch')}>
          <span className="flex h-[112px] w-24 items-center justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={sketch} alt="Engraving sketch" className="max-h-full max-w-full object-contain" />
          </span>
          <span className="text-xs font-medium text-slate-700">Engraving sketch</span>
        </button>

        {PENDANT_MATERIAL_LIST.map((option) => {
          const isSelected = selected === option.id;
          return (
            <button key={option.id} type="button" role="radio" aria-checked={isSelected} onClick={() => setSelected(option.id)} className={optionClass(isSelected)}>
              <PendantPreview
                sketch={sketch}
                shape={shape}
                material={option.id}
                category={category}
                designType={designType}
                contour={contour}
                rimColor={rimColor}
                transform={transform}
                size={96}
              />
              <span className="text-xs font-medium text-slate-700">{option.label} preview</span>
            </button>
          );
        })}
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
          {error}
        </div>
      )}

      <div className="flex flex-col items-center gap-2">
        <button
          type="button"
          onClick={download}
          disabled={status === 'loading' || pendantUnavailable}
          className="inline-flex items-center justify-center gap-2 rounded-full border border-slate-300 bg-white px-6 py-3 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status === 'loading'
            ? 'Preparing…'
            : selected === 'sketch'
              ? 'Download PNG — Engraving sketch'
              : `Download PNG — ${designLabel} · ${PENDANT_MATERIAL_LIST.find((m) => m.id === selected)?.label ?? ''}`}
        </button>
      </div>
    </div>
  );
}
