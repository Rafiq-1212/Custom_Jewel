'use client';

/**
 * Custom Pendant Design workflow.
 *
 * Two completely separate operations, on purpose:
 *
 *   Operation 1 — AI generation (this file's `generateSketch`)
 *     originalImage -> POST /api/generate-image -> masterSketch
 *     Runs exactly once per click of "Generate Sketch" (or an explicit,
 *     deliberate "Regenerate" of the same photo). Nothing else in this file
 *     calls that endpoint. `/api/generate-image` itself also crops and
 *     removes the background before responding (lib/image-processing.ts) —
 *     deterministic pixel arithmetic, not a second AI call — so what lands in
 *     `masterSketch` already has no rectangular boundary to leak through any
 *     later transform.
 *
 *   Operation 2 — product customisation (everything below `masterSketch`)
 *     category, shape, material, zoom/position/rotation are all plain React
 *     state. Their setters do nothing but set state — no fetch, no AI, ever.
 *     The <PendantPreview> canvas is what turns masterSketch + category +
 *     shape + material + transform into a picture, entirely on the client.
 *     /api/export-laser (SVG/DXF/PNG) is the same story: vectorization and
 *     rasterization of the existing masterSketch, never a new generation.
 *
 * The two are wired so that once `masterSketch !== null`, nothing in
 * Operation 2 can put it back to `null` or call Operation 1 again.
 */

import * as React from 'react';
import { DownloadPanel } from '@/components/DownloadPanel';
import { EdgeCutStylePicker } from '@/components/EdgeCutStylePicker';
import { ExportPanel } from '@/components/ExportPanel';
import { GeneratedImage } from '@/components/GeneratedImage';
import { GenerationProgress } from '@/components/GenerationProgress';
import { ImagePreview } from '@/components/ImagePreview';
import { ImageUploader } from '@/components/ImageUploader';
import { MaterialPicker } from '@/components/MaterialPicker';
import { PendantCategoryPicker } from '@/components/PendantCategoryPicker';
import { PendantControls } from '@/components/PendantControls';
import { PendantDesignPicker } from '@/components/PendantDesignPicker';
import { PendantPreview } from '@/components/PendantPreview';
import { PendantShapePicker } from '@/components/PendantShapePicker';
import { extractSilhouetteContour } from '@/lib/edge-cut-contour';
import { extractPhotoSilhouette } from '@/lib/photo-silhouette';
import { PENDANT_MATERIAL_LIST, type MaterialId } from '@/lib/materials';
import {
  DEFAULT_DESIGN_TYPE,
  DEFAULT_EDGE_CUT_STYLE,
  type DesignType,
  type EdgeCutStyle,
  type SilhouetteContour,
} from '@/lib/pendant-geometry';
import {
  DEFAULT_CATEGORY_ID,
  GENERATION_CATEGORY_LIST,
  PENDANT_CATEGORIES,
  type CategoryId,
} from '@/lib/pendant-categories';
import { DEFAULT_TRANSFORM, PENDANT_SHAPES, type PendantTransform, type ShapeId } from '@/lib/pendant-shapes';
import { clearPendantSession, loadPrefs, loadSketch, savePrefs, saveSketch } from '@/lib/pendant-storage';

type Status = 'idle' | 'generating' | 'done' | 'error';

export default function Home() {
  const [file, setFile] = React.useState<File | null>(null);
  const [originalImage, setOriginalImage] = React.useState<string | null>(null);

  // Deliberately *not* hydrated via a lazy initializer. sessionStorage does
  // not exist during server rendering, so a lazy initializer would read it on
  // the client's first render only — producing exactly the state the server
  // could never have rendered, and a hydration mismatch on every reload where
  // a sketch happens to already be persisted (i.e. this feature's main use
  // case). Both server and client must render these SSR-safe defaults first;
  // the effect below is what's allowed to differ, strictly after hydration.
  const [masterSketch, setMasterSketch] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<Status>('idle');
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  // Operation 2 state. Every setter here is plain React state — none of them
  // is ever wired to the fetch call in `generateSketch` below. The raw
  // uploaded photo is deliberately not persisted alongside these: it isn't
  // the master asset, the sketch is, and re-encoding a multi-MB photo into
  // sessionStorage on every upload isn't worth what it would buy.
  // `null` until the customer actively picks one — generation is blocked
  // until then (see `generateSketch`), since the category now also selects
  // Gemini's framing prompt, not just a post-generation crop preset. Once a
  // sketch exists this is guaranteed non-null (`activeCategoryId` below);
  // there's no post-generation UI to unset it, so it never reverts to null
  // except via `startOver`.
  const [selectedCategory, setSelectedCategory] = React.useState<CategoryId | null>(null);
  const [selectedShape, setSelectedShape] = React.useState<ShapeId>('heart');
  const [selectedMaterial, setSelectedMaterial] = React.useState<MaterialId>('silver');
  const [transform, setTransform] = React.useState<PendantTransform>(DEFAULT_TRANSFORM);
  const [selectedDesignType, setSelectedDesignType] = React.useState<DesignType>(DEFAULT_DESIGN_TYPE);
  const [selectedEdgeCutStyle, setSelectedEdgeCutStyle] = React.useState<EdgeCutStyle>(DEFAULT_EDGE_CUT_STYLE);

  // A concrete, non-null category for every consumer downstream of
  // generation (PendantPreview, ExportPanel, prefs). `hasSketch` can only be
  // true once `generateSketch` has already required `selectedCategory` to be
  // set, so the `DEFAULT_CATEGORY_ID` fallback here is defensive only and
  // never actually observed.
  const activeCategoryId: CategoryId = selectedCategory ?? DEFAULT_CATEGORY_ID;

  // Two independent silhouette sources, both computed eagerly (not only when
  // Edge Cut is selected) so switching to any edge-cut style never has to
  // wait:
  //
  //   inkContour    — traced from the sketch's own ink (lib/edge-cut-
  //                   contour.ts). Always attempted; works even after a
  //                   reload, since masterSketch is the one thing persisted.
  //                   Backs 'free'/'heart'.
  //
  //   photoContours — traced from the ORIGINAL photo (lib/photo-
  //                   silhouette.ts), a materially more accurate subject
  //                   outline. Only attempted while `originalImage` is still
  //                   in memory this session (never persisted — see
  //                   pendant-storage.ts). Preferred over inkContour for
  //                   'free'/'heart' whenever available; required for
  //                   'bust'/'band', which have no sensible ink-based
  //                   fallback (truncating or band-offsetting a sparse ink
  //                   trace just amplifies its inaccuracy).
  const [inkContour, setInkContour] = React.useState<SilhouetteContour | null>(null);
  const [inkContourError, setInkContourError] = React.useState<string | null>(null);
  const [photoContours, setPhotoContours] = React.useState<{
    full: SilhouetteContour;
    bust: SilhouetteContour;
    band: SilhouetteContour;
  } | null>(null);
  const [photoContourError, setPhotoContourError] = React.useState<string | null>(null);

  const requestIdRef = React.useRef(0);
  const hydratedRef = React.useRef(false);

  const originalImageRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    originalImageRef.current = originalImage;
  }, [originalImage]);
  React.useEffect(
    () => () => {
      if (originalImageRef.current) URL.revokeObjectURL(originalImageRef.current);
    },
    [],
  );

  // Hydration must happen in an effect, not a lazy initializer: sessionStorage
  // doesn't exist on the server, so this is the one place in this file where
  // an effect calling setState is the correct tool rather than the antipattern
  // the react-hooks/set-state-in-effect rule usually catches — there is no
  // render-time computation that could produce this value on the server.
  const [isHydrated, setIsHydrated] = React.useState(false);
  /* eslint-disable react-hooks/set-state-in-effect --
     Reading a browser-only store and syncing React state to it can only
     happen after mount; both the loaded values and the isHydrated flag that
     gates the save-effects below on it are unavoidably set here. */
  React.useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;

    const storedSketch = loadSketch();
    if (storedSketch) {
      setMasterSketch(storedSketch);
      setStatus('done');
    }

    const prefs = loadPrefs();
    if (prefs) {
      setSelectedCategory(prefs.selectedCategory);
      setSelectedShape(prefs.selectedShape);
      setSelectedMaterial(prefs.selectedMaterial);
      setTransform(prefs.transform);
      setSelectedDesignType(prefs.designType);
      setSelectedEdgeCutStyle(prefs.edgeCutStyle);
    }

    setIsHydrated(true);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Gated on `isHydrated` so this can never fire on the same commit as the
  // hydration effect above and write `null` back over a sketch that effect
  // just read but hasn't finished applying to state yet.
  React.useEffect(() => {
    if (!isHydrated) return;
    saveSketch(masterSketch);
  }, [isHydrated, masterSketch]);

  React.useEffect(() => {
    if (!isHydrated || !masterSketch) return;
    savePrefs({
      selectedCategory: activeCategoryId,
      selectedShape,
      selectedMaterial,
      transform,
      designType: selectedDesignType,
      edgeCutStyle: selectedEdgeCutStyle,
    });
  }, [
    isHydrated,
    masterSketch,
    activeCategoryId,
    selectedShape,
    selectedMaterial,
    transform,
    selectedDesignType,
    selectedEdgeCutStyle,
  ]);

  // The ink-traced silhouette is stale the moment `masterSketch` itself
  // changes (a fresh generation, a different stored sketch loading in, or it
  // being cleared) — reset synchronously during render rather than in an
  // effect body, the same "compare against state" pattern ExportPanel uses
  // for its own prepared vector assets.
  const [inkContourForSketch, setInkContourForSketch] = React.useState<string | null>(null);
  if (masterSketch !== inkContourForSketch) {
    setInkContourForSketch(masterSketch);
    if (inkContour) setInkContour(null);
    if (inkContourError) setInkContourError(null);
  }

  // Recomputes only when `masterSketch` changes — never on a shape/design/
  // style/transform change. Never a second AI call: this is deterministic
  // client-side pixel geometry on the exact sketch Gemini already produced
  // (lib/edge-cut-contour.ts).
  React.useEffect(() => {
    if (!masterSketch) return;
    let cancelled = false;
    extractSilhouetteContour(masterSketch)
      .then((result) => {
        if (!cancelled) setInkContour(result);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setInkContourError(
          error instanceof Error ? error.message : 'Could not trace an edge-cut boundary from this sketch.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [masterSketch]);

  // The photo-traced silhouettes are stale the moment `originalImage`
  // changes (a new upload, or it being cleared — e.g. after a reload, since
  // it's never persisted) — same synchronous, render-time reset pattern.
  const [photoContoursForImage, setPhotoContoursForImage] = React.useState<string | null>(null);
  if (originalImage !== photoContoursForImage) {
    setPhotoContoursForImage(originalImage);
    if (photoContours) setPhotoContours(null);
    if (photoContourError) setPhotoContourError(null);
  }

  // Recomputes only when `originalImage` changes — never on a shape/design/
  // style/transform change, and never on "Regenerate from the same photo"
  // either (masterSketch changes, but originalImage doesn't). Never a
  // second AI call: classical background-removal heuristics on the photo
  // the customer already uploaded (lib/photo-silhouette.ts).
  React.useEffect(() => {
    if (!originalImage) return;
    let cancelled = false;
    Promise.all([
      extractPhotoSilhouette(originalImage, 'full'),
      extractPhotoSilhouette(originalImage, 'bust'),
      extractPhotoSilhouette(originalImage, 'band'),
    ])
      .then(([full, bust, band]) => {
        if (!cancelled) setPhotoContours({ full, bust, band });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPhotoContourError(
          error instanceof Error ? error.message : 'Could not trace a silhouette from this photo.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [originalImage]);

  // remove.bg (lib/remove-bg-contour.ts, /api/edge-cut/remove-background) is
  // deliberately NOT wired in here. It was, briefly — but its result arrives
  // several seconds after the instant local fallback below has already
  // painted and been seen, and verified directly (reload -> fallback shown
  // at ~1.3s -> remove.bg response at ~5.3s -> canvas silently repaints with
  // a different boundary) that this is exactly the "the image changes after
  // a few seconds" the customer reported and explicitly did not want: they
  // want whatever boundary displays first to stay final. The library/route
  // are left in place, complete and working, for a future revisit — ideally
  // behind a real loading state that withholds the fallback until remove.bg
  // either resolves or a timeout elapses, so nothing already on screen ever
  // has to change.

  /** Which silhouette actually backs the customer's currently-selected edge-cut style. */
  const resolveContourForStyle = React.useCallback(
    (style: EdgeCutStyle): SilhouetteContour | null => {
      if (style === 'bust') return photoContours?.bust ?? null;
      if (style === 'band') return photoContours?.band ?? null;
      // 'free' and 'heart': prefer the photo-based silhouette, fall back to
      // the ink-based one so these two keep working even without a photo.
      return photoContours?.full ?? inkContour;
    },
    [photoContours, inkContour],
  );

  const activeContour = resolveContourForStyle(selectedEdgeCutStyle);
  const freeHeartReady = !!(photoContours?.full ?? inkContour);
  const edgeCutDisabledStyles: EdgeCutStyle[] = [
    ...(freeHeartReady ? [] : (['free', 'heart'] as EdgeCutStyle[])),
    ...(photoContours ? [] : (['bust', 'band'] as EdgeCutStyle[])),
  ];
  // Only surfaced as a blocking error when free/heart have nothing to fall
  // back on either — if the photo-based silhouette failed but the ink-based
  // one succeeded, free/heart are still fully usable and this stays silent.
  const edgeCutBlockingError = freeHeartReady ? null : (photoContourError ?? inkContourError);

  const handleFileSelected = (selected: File) => {
    if (originalImage) URL.revokeObjectURL(originalImage);
    setFile(selected);
    setOriginalImage(URL.createObjectURL(selected));
    setErrorMessage(null);
    setStatus('idle');
    // A new photo means any previous sketch no longer corresponds to what's
    // shown as "Original Photo" — clear it so the two can't drift apart.
    setMasterSketch(null);
  };

  const handleValidationError = (message: string) => {
    setErrorMessage(message);
  };

  /**
   * Operation 1. The only function in this file that calls the AI, and the
   * only place `masterSketch` is ever set from a network response. Guarded
   * three times: `status === 'generating'` blocks a double-click, a missing
   * `selectedCategory` blocks generation before the customer has picked a
   * category (the category now selects Gemini's framing prompt server-side —
   * see `/api/generate-image`), and every response is stamped with a request
   * id so a slow, superseded response can never land after a newer one
   * already has.
   */
  const generateSketch = async () => {
    if (!file || status === 'generating') return;
    if (!selectedCategory) {
      setErrorMessage('Please select a pendant category before generating your design.');
      return;
    }

    const requestId = ++requestIdRef.current;
    setStatus('generating');
    setErrorMessage(null);
    setMasterSketch(null);

    try {
      const formData = new FormData();
      formData.set('file', file);
      formData.set('category', selectedCategory);

      const response = await fetch('/api/generate-image', { method: 'POST', body: formData });
      const body = (await response.json().catch(() => null)) as
        | { success: true; image: string }
        | { success: false; error: string }
        | null;

      if (requestId !== requestIdRef.current) return; // superseded by a newer request

      if (!body) {
        setErrorMessage('Unable to generate the image. Please try again.');
        setStatus('error');
        return;
      }

      if (!response.ok || !body.success) {
        setErrorMessage(body.success ? 'Unable to generate the image. Please try again.' : body.error);
        setStatus('error');
        return;
      }

      setMasterSketch(body.image);
      setStatus('done');
    } catch {
      if (requestId !== requestIdRef.current) return;
      setErrorMessage('Unable to reach the image service. Please check your connection and try again.');
      setStatus('error');
    }
  };

  const startOver = () => {
    if (originalImage) URL.revokeObjectURL(originalImage);
    setFile(null);
    setOriginalImage(null);
    setMasterSketch(null);
    setErrorMessage(null);
    setStatus('idle');
    setSelectedCategory(null);
    setSelectedShape('heart');
    setSelectedMaterial('silver');
    setTransform(DEFAULT_TRANSFORM);
    setSelectedDesignType(DEFAULT_DESIGN_TYPE);
    setSelectedEdgeCutStyle(DEFAULT_EDGE_CUT_STYLE);
    setInkContour(null);
    setInkContourError(null);
    setPhotoContours(null);
    setPhotoContourError(null);
    clearPendantSession();
  };

  const isGenerating = status === 'generating';
  const hasSketch = masterSketch !== null;

  return (
    <main className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-10 px-4 py-12 sm:px-6">
      <header className="flex flex-col gap-2 text-center">
        <h1 className="text-2xl font-semibold text-slate-900 sm:text-3xl">Custom Pendant Design</h1>
        <p className="text-sm text-slate-500">
          Upload a photo once — try every category, shape and metal instantly, with no extra AI calls.
        </p>
      </header>

      {errorMessage && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {errorMessage}
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* 1. UPLOAD PHOTO                                                   */}
      {/* ---------------------------------------------------------------- */}
      <Section step={1} title="Upload Photo">
        {!hasSketch ? (
          <div className="flex flex-col gap-6">
            {!originalImage ? (
              <ImageUploader onFileSelected={handleFileSelected} onValidationError={handleValidationError} />
            ) : (
              <>
                <div className="mx-auto w-full max-w-xs">
                  <ImagePreview src={originalImage} alt="Your uploaded photo" label="Original Photo" />
                </div>
                <div className="flex justify-center">
                  <button
                    type="button"
                    onClick={() => {
                      setOriginalImage((current) => {
                        if (current) URL.revokeObjectURL(current);
                        return null;
                      });
                      setFile(null);
                    }}
                    disabled={isGenerating}
                    className="text-sm font-medium text-slate-500 underline-offset-4 hover:text-slate-700 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Choose a different photo
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <SummaryRow
            label={originalImage ? 'Photo uploaded' : 'Photo uploaded (from a previous session)'}
            action={{ label: 'Start over with a new photo', onClick: startOver }}
          />
        )}
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* 2. CHOOSE PENDANT CATEGORY (before generation — controls the      */}
      {/*    Gemini prompt) + GENERATE                                      */}
      {/* ---------------------------------------------------------------- */}
      {!hasSketch && originalImage && (
        <Section step={2} title="Choose Pendant Category">
          <div className="flex flex-col gap-4">
            <PendantCategoryPicker
              value={selectedCategory}
              onChange={setSelectedCategory}
              categories={GENERATION_CATEGORY_LIST}
            />
            <p className="text-xs text-slate-400">
              This controls how much of your photo the AI includes in the sketch — the exact pendant shape (Heart,
              Edge Cut, ...) is chosen after generation.
            </p>
            <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
              <button
                type="button"
                onClick={generateSketch}
                disabled={isGenerating || !selectedCategory}
                className="inline-flex items-center justify-center gap-2 rounded-full bg-slate-900 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Generate Sketch
              </button>
            </div>
            {!selectedCategory && (
              <p className="text-center text-xs text-amber-600">
                Please select a pendant category before generating your design.
              </p>
            )}
            {isGenerating && <GenerationProgress />}
          </div>
        </Section>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* 3. MASTER SKETCH                                                  */}
      {/* ---------------------------------------------------------------- */}
      {hasSketch && (
        <Section step={3} title="Master Sketch">
          <div className="flex flex-col gap-4">
            <div className="mx-auto w-full max-w-xs">
              <GeneratedImage image={masterSketch} />
            </div>
            <p className="flex items-center justify-center gap-1.5 text-sm font-medium text-emerald-700">
              <span aria-hidden>✓</span> Sketch generated as a {PENDANT_CATEGORIES[activeCategoryId].label} — this
              exact image is reused for every shape and metal below. Generating it again requires an explicit
              click.
            </p>
            {file && (
              <button
                type="button"
                onClick={generateSketch}
                disabled={isGenerating}
                className="mx-auto text-xs font-medium text-slate-500 underline-offset-4 hover:text-slate-700 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
              >
                Not quite right? Regenerate from the same photo (calls the AI again)
              </button>
            )}
          </div>
        </Section>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* 4. CHOOSE PENDANT DESIGN                                          */}
      {/* ---------------------------------------------------------------- */}
      {hasSketch && (
        <Section step={4} title="Choose Pendant Design">
          <PendantDesignPicker value={selectedDesignType} onChange={setSelectedDesignType} />
        </Section>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* 5. CHOOSE PENDANT SHAPE / EDGE CUT STYLE                          */}
      {/* ---------------------------------------------------------------- */}
      {hasSketch && (
        <Section step={5} title={selectedDesignType === 'standard' ? 'Choose Pendant Shape' : 'Edge Cut Style'}>
          {selectedDesignType === 'standard' ? (
            <PendantShapePicker value={selectedShape} onChange={setSelectedShape} />
          ) : (
            <div className="flex flex-col gap-2">
              <EdgeCutStylePicker
                value={selectedEdgeCutStyle}
                onChange={setSelectedEdgeCutStyle}
                disabledStyles={edgeCutDisabledStyles}
                disabledReason={
                  freeHeartReady
                    ? 'Needs the original photo from this upload, which is not available right now.'
                    : undefined
                }
              />
              {edgeCutBlockingError && (
                <p role="alert" className="text-xs text-red-600">
                  {edgeCutBlockingError} Standard shapes are still fully available.
                </p>
              )}
              {!freeHeartReady && !edgeCutBlockingError && (
                <p className="text-xs text-slate-400">Analyzing the photo for an edge-cut boundary…</p>
              )}
              {freeHeartReady && !photoContours && !photoContourError && (
                <p className="text-xs text-slate-400">
                  Analyzing the original photo for Bust with Base and Silhouette Band…
                </p>
              )}
              {freeHeartReady && photoContourError && (
                <p className="text-xs text-slate-400">
                  Bust with Base and Silhouette Band aren&apos;t available for this photo ({photoContourError}) — Free
                  Edge Cut and Edge Cut inside Heart are unaffected.
                </p>
              )}
            </div>
          )}
        </Section>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* 6. CHOOSE MATERIAL                                                */}
      {/* ---------------------------------------------------------------- */}
      {hasSketch && (
        <Section step={6} title="Choose Material">
          <MaterialPicker value={selectedMaterial} onChange={setSelectedMaterial} />
        </Section>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* 7. PENDANT PREVIEW                                                */}
      {/* ---------------------------------------------------------------- */}
      {hasSketch && (
        <Section step={7} title="Pendant Preview">
          <div className="flex flex-col items-center gap-8">
            <PendantPreview
              sketch={masterSketch}
              shape={selectedShape}
              material={selectedMaterial}
              category={activeCategoryId}
              designType={selectedDesignType}
              edgeCutStyle={selectedEdgeCutStyle}
              contour={activeContour}
              transform={transform}
              size={280}
            />

            <div className="flex w-full flex-col gap-3 border-t border-slate-100 pt-6">
              <p className="text-center text-xs font-medium uppercase tracking-wide text-slate-400">
                Compare finishes — {PENDANT_CATEGORIES[activeCategoryId].label} ·{' '}
                {selectedDesignType === 'standard' ? PENDANT_SHAPES[selectedShape].label : 'Edge Cut'}
              </p>
              <div className="flex items-start justify-center gap-8">
                {PENDANT_MATERIAL_LIST.map((material) => (
                  <div key={material.id} className="flex flex-col items-center gap-2">
                    <PendantPreview
                      sketch={masterSketch}
                      shape={selectedShape}
                      material={material.id}
                      category={activeCategoryId}
                      designType={selectedDesignType}
                      edgeCutStyle={selectedEdgeCutStyle}
                      contour={activeContour}
                      transform={transform}
                      size={120}
                      className={
                        material.id === selectedMaterial ? 'rounded-lg ring-2 ring-slate-900 ring-offset-2' : ''
                      }
                    />
                    <span className="text-xs font-medium text-slate-500">{material.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Section>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* 8. CUSTOMIZE IMAGE                                                */}
      {/* ---------------------------------------------------------------- */}
      {hasSketch && (
        <Section step={8} title="Customize Image">
          <PendantControls transform={transform} onChange={setTransform} />
        </Section>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* 9. EXPORT FOR LASER CUTTING                                       */}
      {/* ---------------------------------------------------------------- */}
      {hasSketch && (
        <Section step={9} title="Export for Laser Cutting">
          <ExportPanel
            sketch={masterSketch}
            shape={selectedShape}
            material={selectedMaterial}
            category={activeCategoryId}
            designType={selectedDesignType}
            edgeCutStyle={selectedEdgeCutStyle}
            contour={activeContour}
            transform={transform}
          />
        </Section>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* 10. DOWNLOAD — pick one PNG output, save it                       */}
      {/* ---------------------------------------------------------------- */}
      {hasSketch && (
        <Section step={10} title="Download">
          <DownloadPanel
            sketch={masterSketch}
            shape={selectedShape}
            material={selectedMaterial}
            category={activeCategoryId}
            designType={selectedDesignType}
            edgeCutStyle={selectedEdgeCutStyle}
            contour={activeContour}
            transform={transform}
          />
        </Section>
      )}
    </main>
  );
}

function Section({
  step,
  title,
  children,
}: {
  step: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4 border-t border-slate-200 pt-8 first:border-t-0 first:pt-0">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
        {step}. {title}
      </h2>
      {children}
    </section>
  );
}

function SummaryRow({
  label,
  action,
}: {
  label: string;
  action: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
      <span className="flex items-center gap-1.5 text-sm text-slate-600">
        <span aria-hidden className="text-emerald-600">
          ✓
        </span>
        {label}
      </span>
      <button
        type="button"
        onClick={action.onClick}
        className="text-xs font-medium text-slate-500 underline-offset-4 hover:text-slate-700 hover:underline"
      >
        {action.label}
      </button>
    </div>
  );
}
