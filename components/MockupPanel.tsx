'use client';

/**
 * Photorealistic product mockups — the images that go on the e-commerce
 * listing. One button per metal; each click is one deliberate call to
 * `/api/render-mockup` (the app's second Gemini use, see lib/mockup.ts).
 * Results are kept until the design itself changes — then they're stale by
 * definition and are cleared rather than shown next to a pendant they no
 * longer match.
 */

import * as React from 'react';
import { dataUrlToBlob, downloadFile, extensionForDataUrl } from '@/lib/download';
import { PENDANT_MATERIAL_LIST, type MaterialId, type RimColorId } from '@/lib/materials';
import { PENDANT_CATEGORIES, type CategoryId } from '@/lib/pendant-categories';
import type { DesignType, SilhouetteContour } from '@/lib/pendant-geometry';
import { PENDANT_SHAPES, type PendantTransform, type ShapeId } from '@/lib/pendant-shapes';

type MockupState = { status: 'loading' } | { status: 'done'; dataUrl: string } | { status: 'error'; error: string };

export function MockupPanel({
  sketch,
  shape,
  category,
  designType,
  contour,
  rimColor,
  transform,
}: {
  sketch: string;
  shape: ShapeId;
  category: CategoryId;
  designType: DesignType;
  contour: SilhouetteContour | null;
  rimColor: RimColorId;
  transform: PendantTransform;
}) {
  const engravingArea = PENDANT_CATEGORIES[category].engravingArea;
  const [mockups, setMockups] = React.useState<Partial<Record<MaterialId, MockupState>>>({});
  const requestKeyRef = React.useRef<Partial<Record<MaterialId, string>>>({});

  // Anything that changes the pendant invalidates every rendered mockup —
  // React's documented "reset state when a derived value changes" pattern.
  const designKey = JSON.stringify({ sketch: sketch.length, shape, category, designType, contour, rimColor, transform });
  const [renderedKey, setRenderedKey] = React.useState(designKey);
  if (designKey !== renderedKey) {
    setRenderedKey(designKey);
    if (Object.keys(mockups).length) setMockups({});
  }

  const silhouettePending = designType === 'edge-cut' && !contour;

  const render = async (material: MaterialId) => {
    const key = `${designKey}:${material}`;
    requestKeyRef.current[material] = key;
    setMockups((m) => ({ ...m, [material]: { status: 'loading' } }));
    try {
      const response = await fetch('/api/render-mockup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sketch, shape, material, transform, engravingArea, designType, contour, rimColor, category }),
      });
      const body = (await response.json().catch(() => null)) as
        | { success: true; dataUrl: string }
        | { success: false; error: string }
        | null;
      if (requestKeyRef.current[material] !== key) return; // superseded
      if (!body || !response.ok || !body.success) {
        const error = body && !body.success ? body.error : 'We couldn\'t make the product photo. Please try again.';
        setMockups((m) => ({ ...m, [material]: { status: 'error', error } }));
        return;
      }
      setMockups((m) => ({ ...m, [material]: { status: 'done', dataUrl: body.dataUrl } }));
    } catch {
      if (requestKeyRef.current[material] !== key) return;
      setMockups((m) => ({
        ...m,
        [material]: { status: 'error', error: 'We couldn\'t connect. Check your internet and try again.' },
      }));
    }
  };

  const designLabel = designType === 'edge-cut' ? PENDANT_CATEGORIES[category].label : `${PENDANT_SHAPES[shape].label} pendant`;

  return (
    <div className="flex flex-col gap-5">
      <p className="text-xs text-slate-500">
        A realistic photo of this exact pendant, ready for your product page. Each one takes about 10 to 15 seconds to
        make.
      </p>

      <div className="grid gap-6 sm:grid-cols-2">
        {PENDANT_MATERIAL_LIST.map((material) => {
          const state = mockups[material.id];
          return (
            <div key={material.id} className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-800">{material.label}</span>
                <button
                  type="button"
                  onClick={() => render(material.id)}
                  disabled={state?.status === 'loading' || silhouettePending}
                  className="inline-flex items-center justify-center rounded-full bg-slate-900 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {state?.status === 'loading'
                    ? 'Making photo…'
                    : state?.status === 'done'
                      ? 'Make another'
                      : `Make ${material.label.toLowerCase()} photo`}
                </button>
              </div>

              <div className="flex aspect-square items-center justify-center overflow-hidden rounded-2xl border border-slate-200 bg-[#f4efe6]">
                {state?.status === 'done' ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={state.dataUrl} alt={`${material.label} ${designLabel} product mockup`} className="h-full w-full object-contain" />
                ) : state?.status === 'loading' ? (
                  <span className="text-xs text-slate-400">Photographing the {material.label.toLowerCase()} pendant…</span>
                ) : (
                  <span className="px-6 text-center text-xs text-slate-400">No photo yet.</span>
                )}
              </div>

              {state?.status === 'error' && (
                <p role="alert" className="text-xs text-red-600">
                  {state.error}
                </p>
              )}
              {state?.status === 'done' && (
                <button
                  type="button"
                  onClick={async () =>
                    downloadFile(
                      `mockup-${designLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${material.id}.${extensionForDataUrl(state.dataUrl)}`,
                      await dataUrlToBlob(state.dataUrl),
                    )
                  }
                  className="inline-flex items-center justify-center self-start rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
                >
                  Download {material.label.toLowerCase()} photo
                </button>
              )}
            </div>
          );
        })}
      </div>

      {silhouettePending && (
        <p className="text-xs text-slate-400">Just a moment while we work out the cut line.</p>
      )}
    </div>
  );
}
