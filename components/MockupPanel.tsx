'use client';

/**
 * Photorealistic product mockups — the images that go on the e-commerce
 * listing. One button per metal; each click is one deliberate call to
 * `/api/render-mockup` (the app's second Gemini use, see lib/mockup.ts), and
 * each call costs about six rupees.
 *
 * A photo belongs to one exact pendant, so it is stored under a key made of
 * the whole design — sketch, shape, cut, rim, position — and shown only
 * beside that design. Changing anything therefore hides it, as it always
 * did, but it is now KEPT rather than thrown away: nudging the position and
 * nudging it back shows the photo already paid for instead of charging for
 * it a second time. That undo is the common case, and it used to cost money
 * every time.
 *
 * The store is in memory and holds the last few renders, so a reload or a
 * long session of sliding still ends in a fresh call.
 */

import * as React from 'react';
import { dataUrlToBlob, downloadFile, extensionForDataUrl } from '@/lib/download';
import { PENDANT_MATERIAL_LIST, type MaterialId, type RimColorId } from '@/lib/materials';
import { PENDANT_CATEGORIES, type CategoryId } from '@/lib/pendant-categories';
import type { DesignType, SilhouetteContour } from '@/lib/pendant-geometry';
import { PENDANT_SHAPES, type PendantTransform, type ShapeId } from '@/lib/pendant-shapes';

type MockupState = { status: 'loading' } | { status: 'done'; dataUrl: string } | { status: 'error'; error: string };

/**
 * Each finished photo is a data URL of a megabyte or two, so the store is
 * capped. Object keys keep their insertion order, so the oldest go first —
 * far enough back that an operator trying settings and returning to one still
 * finds it.
 */
const MAX_KEPT = 8;

function keepRecent(mockups: Record<string, MockupState>): Record<string, MockupState> {
  const keys = Object.keys(mockups);
  if (keys.length <= MAX_KEPT) return mockups;
  const kept = { ...mockups };
  for (const key of keys.slice(0, keys.length - MAX_KEPT)) delete kept[key];
  return kept;
}

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
  // Keyed by design AND metal, so a photo is only ever shown beside the
  // pendant it was made for; see the note at the top of this file.
  const [mockups, setMockups] = React.useState<Record<string, MockupState>>({});
  const designKey = JSON.stringify({ sketch: sketch.length, shape, category, designType, contour, rimColor, transform });

  const silhouettePending = designType === 'edge-cut' && !contour;

  const render = async (material: MaterialId) => {
    const key = `${designKey}:${material}`;
    setMockups((m) => ({ ...m, [key]: { status: 'loading' } }));
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
      // Stored under its own key whatever the operator changed while it was
      // being made: the photo is valid for the design it was asked for, and
      // going back to that design should find it waiting.
      if (!body || !response.ok || !body.success) {
        const error = body && !body.success ? body.error : 'We couldn\'t make the product photo. Please try again.';
        setMockups((m) => ({ ...m, [key]: { status: 'error', error } }));
        return;
      }
      setMockups((m) => keepRecent({ ...m, [key]: { status: 'done', dataUrl: body.dataUrl } }));
    } catch {
      setMockups((m) => ({
        ...m,
        [key]: { status: 'error', error: 'We couldn\'t connect. Check your internet and try again.' },
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
          const state = mockups[`${designKey}:${material.id}`];
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
