'use client';

/**
 * Photorealistic product mockups — the images that go on the e-commerce
 * listing. One button per metal; each click is one deliberate call to
 * `/api/render-mockup` (the app's second Gemini use, see lib/mockup.ts). It
 * is queued as a batch job at half price, about three rupees instead of six,
 * so the button submits the job and this panel polls until the picture is
 * ready rather than holding one long request open.
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
import { FeedbackPanel } from './FeedbackPanel';
import { finalPicture, MockupError, PRODUCT_PHOTO_FROM, runMockup } from '@/lib/mockup-client';
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
  job,
}: {
  sketch: string;
  /** The design, for feedback on the photo once there is one. */
  job: string | null;
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

  // 'preview' mode: the final gold and silver pictures cost nothing, so both
  // are made as soon as there is a design, follow every change, and are saved
  // with the design each time (one file per metal, replaced: see
  // /api/product-preview). Nobody has to remember to save them.
  const live = PRODUCT_PHOTO_FROM === 'preview';
  const [pictures, setPictures] = React.useState<{ key: string; urls: Partial<Record<MaterialId, string>> }>({ key: '', urls: {} });
  React.useEffect(() => {
    if (!live || silhouettePending) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const urls: Partial<Record<MaterialId, string>> = {};
      for (const material of PENDANT_MATERIAL_LIST) {
        try {
          urls[material.id] = await finalPicture({ sketch, shape, material: material.id, transform, engravingArea, designType, contour, rimColor, category }, true);
        } catch {
          // Left out: the tile says so, and Save can still try again.
        }
      }
      if (!cancelled) setPictures({ key: designKey, urls });
    }, 1200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [live, silhouettePending, designKey, sketch, shape, transform, engravingArea, category, designType, contour, rimColor]);

  const render = async (material: MaterialId) => {
    const key = `${designKey}:${material}`;
    setMockups((m) => ({ ...m, [key]: { status: 'loading' } }));
    try {
      // The wait happens in the browser (lib/mockup-client.ts): the picture
      // is a batch job, answered when Google gets to it. The result is stored
      // under its own key whatever the operator changed meanwhile — the photo
      // is valid for the design it was asked for, and going back to that
      // design should find it waiting rather than charging again.
      const dataUrl = await runMockup({ sketch, shape, material, transform, engravingArea, designType, contour, rimColor, category });
      setMockups((m) => keepRecent({ ...m, [key]: { status: 'done', dataUrl } }));
    } catch (error) {
      setMockups((m) => ({
        ...m,
        [key]: {
          status: 'error',
          error: error instanceof MockupError ? error.message : 'We couldn\'t connect. Check your internet and try again.',
        },
      }));
    }
  };

  const designLabel = designType === 'edge-cut' ? PENDANT_CATEGORIES[category].label : `${PENDANT_SHAPES[shape].label} pendant`;

  return (
    <div className="flex flex-col gap-5">
      {PRODUCT_PHOTO_FROM === 'ai' ? (
        <p className="text-xs text-slate-500">
          A realistic photo of this exact pendant, ready for your product page. Each one is queued at half price, so it
          takes a few minutes — leave this page open while it comes back.
        </p>
      ) : (
        <p className="text-xs text-slate-500">
          The final picture of this exact pendant in each metal, with its ring, made straight from the sketch at no cost.
          It follows every change above and is saved with this design by itself.
        </p>
      )}

      <div className="grid gap-6 sm:grid-cols-2">
        {PENDANT_MATERIAL_LIST.map((material) => {
          const saved = mockups[`${designKey}:${material.id}`];
          const livePicture = live && pictures.key === designKey ? pictures.urls[material.id] : undefined;
          // Shown like a finished photo, so the tile and Download work the same either way.
          const state: MockupState | undefined = saved ?? (livePicture ? { status: 'done', dataUrl: livePicture } : undefined);
          return (
            <div key={material.id} className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-800">{material.label}</span>
                {live ? (
                  // Saved by itself whenever it is drawn (see the effect above).
                  <span className={`text-xs ${livePicture || pictures.key !== designKey ? 'text-slate-500' : 'text-red-600'}`}>
                    {livePicture ? 'Saved with this design' : pictures.key === designKey ? 'Not saved: change anything to try again' : 'Drawing…'}
                  </span>
                ) : (
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
                )}
              </div>

              <div className="flex aspect-square items-center justify-center overflow-hidden rounded-2xl border border-slate-200 bg-[#f4efe6]">
                {state?.status === 'done' ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={state.dataUrl} alt={`${material.label} ${designLabel} product mockup`} className="h-full w-full object-contain" />
                ) : state?.status === 'loading' || live ? (
                  <span className="text-xs text-slate-400">
                    {live ? 'Drawing' : 'Photographing'} the {material.label.toLowerCase()} pendant…
                  </span>
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

      {Object.values(mockups).some((m) => m.status === 'done') && <FeedbackPanel key={job} job={job} stage="product_photo" />}
    </div>
  );
}
