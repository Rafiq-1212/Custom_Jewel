'use client';

/**
 * Custom Pendant Design workflow — True Tribute's photo-pendant tool.
 *
 * The operator uploads a customer's photo, picks the pendant category, and
 * gets everything the business needs from that one photo:
 *
 *   Operation 1 — AI sketch generation (`generateSketch`)
 *     photo -> POST /api/generate-image -> masterSketch. Runs exactly once
 *     per click of "Generate Sketch" (or an explicit "Regenerate"). The
 *     server also crops and clears the background (lib/image-processing.ts)
 *     — deterministic pixel arithmetic, not a second AI call.
 *
 *   Operation 2 — product customisation (everything below `masterSketch`)
 *     design type, shape, metal, enamel rim, zoom/position/rotation are all
 *     plain React state. <PendantPreview> paints them on a canvas, entirely
 *     client-side. /api/export-laser (SVG/DXF/3DM) is vectorization of the
 *     existing sketch, never a new generation.
 *
 *   Operation 3 — product mockup (components/MockupPanel.tsx)
 *     The one deliberate second AI call: the current design goes to
 *     POST /api/render-mockup for a photorealistic listing photo. Only when
 *     the operator clicks "Render", once per metal, never on a slider drag.
 *
 * Once `masterSketch !== null`, nothing in Operation 2 or 3 can put it back
 * to `null` or call Operation 1 again.
 */

import * as React from 'react';
import { DownloadPanel } from '@/components/DownloadPanel';
import { ExportPanel } from '@/components/ExportPanel';
import { GeneratedImage } from '@/components/GeneratedImage';
import { GenerationProgress } from '@/components/GenerationProgress';
import { PhotoCropper } from '@/components/PhotoCropper';
import { FULL_CROP, cropImageFile, type CropRect } from '@/lib/photo-crop';
import { ImageUploader } from '@/components/ImageUploader';
import { MaterialPicker } from '@/components/MaterialPicker';
import { MockupPanel } from '@/components/MockupPanel';
import { PendantCategoryPicker } from '@/components/PendantCategoryPicker';
import { PendantControls } from '@/components/PendantControls';
import { PendantDesignPicker } from '@/components/PendantDesignPicker';
import { PendantPreview } from '@/components/PendantPreview';
import { PendantShapePicker } from '@/components/PendantShapePicker';
import { RimColorPicker } from '@/components/RimColorPicker';
import { extractSilhouetteContour } from '@/lib/edge-cut-contour';
import { DEFAULT_MATERIAL_ID, DEFAULT_RIM_COLOR_ID, PENDANT_MATERIAL_LIST, type MaterialId, type RimColorId } from '@/lib/materials';
import { DEFAULT_DESIGN_TYPE, type DesignType, type SilhouetteContour } from '@/lib/pendant-geometry';
import { DEFAULT_CATEGORY_ID, GENERATION_CATEGORY_LIST, PENDANT_CATEGORIES, type CategoryId } from '@/lib/pendant-categories';
import { DEFAULT_SHAPE_ID, DEFAULT_TRANSFORM, PENDANT_SHAPES, type PendantTransform, type ShapeId } from '@/lib/pendant-shapes';
import { clearPendantSession, loadPrefs, loadSketch, savePrefs, saveSketch } from '@/lib/pendant-storage';

type Status = 'idle' | 'generating' | 'done' | 'error';

export default function Home() {
  const [file, setFile] = React.useState<File | null>(null);
  const [originalImage, setOriginalImage] = React.useState<string | null>(null);
  // What part of the photo goes to the AI (lib/photo-crop.ts). Kept across
  // "Regenerate" so a redo uses the same framing; reset on a new photo.
  const [crop, setCrop] = React.useState<CropRect>(FULL_CROP);

  // Deliberately *not* hydrated via a lazy initializer: sessionStorage does
  // not exist during server rendering, so both server and client must render
  // these SSR-safe defaults first; the effect below is what's allowed to
  // differ, strictly after hydration.
  const [masterSketch, setMasterSketch] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<Status>('idle');
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  // Operation 2 state. Every setter here is plain React state — none is ever
  // wired to the fetch call in `generateSketch`. `selectedCategory` is null
  // until the operator picks one; generation is blocked until then, since
  // the category also selects Gemini's framing prompt.
  const [selectedCategory, setSelectedCategory] = React.useState<CategoryId | null>(null);
  const [selectedShape, setSelectedShape] = React.useState<ShapeId>(DEFAULT_SHAPE_ID);
  const [selectedMaterial, setSelectedMaterial] = React.useState<MaterialId>(DEFAULT_MATERIAL_ID);
  const [transform, setTransform] = React.useState<PendantTransform>(DEFAULT_TRANSFORM);
  const [selectedDesignType, setSelectedDesignType] = React.useState<DesignType>(DEFAULT_DESIGN_TYPE);
  const [rimColor, setRimColor] = React.useState<RimColorId>(DEFAULT_RIM_COLOR_ID);

  // Non-null for every consumer downstream of generation; the fallback is
  // defensive only, since `hasSketch` requires `selectedCategory` to be set.
  const activeCategoryId: CategoryId = selectedCategory ?? DEFAULT_CATEGORY_ID;

  // The Silhouette Cut boundary, traced from the SKETCH itself (lib/edge-cut-
  // contour.ts) as soon as a sketch exists, so switching to Silhouette Cut
  // never waits. The sketch is the only valid source — see that module's
  // comment for the customer case that proved a photo-based trace can't work.
  const [contour, setContour] = React.useState<SilhouetteContour | null>(null);
  const [contourError, setContourError] = React.useState<string | null>(null);

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

  // Hydration from sessionStorage — the one place an effect calling setState
  // is the correct tool: there is no render-time computation that could
  // produce this value on the server.
  const [isHydrated, setIsHydrated] = React.useState(false);
  /* eslint-disable react-hooks/set-state-in-effect -- browser-only store, read after mount */
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
      setRimColor(prefs.rimColor);
    }
    setIsHydrated(true);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Gated on `isHydrated` so this can never fire on the same commit as the
  // hydration effect and write `null` back over a sketch it just read.
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
      rimColor,
    });
  }, [isHydrated, masterSketch, activeCategoryId, selectedShape, selectedMaterial, transform, selectedDesignType, rimColor]);

  // The traced boundary is stale the moment `masterSketch` changes — reset
  // synchronously during render (the "compare against state" pattern).
  const [contourForSketch, setContourForSketch] = React.useState<string | null>(null);
  if (masterSketch !== contourForSketch) {
    setContourForSketch(masterSketch);
    if (contour) setContour(null);
    if (contourError) setContourError(null);
  }

  // Recomputes only when `masterSketch` changes — never on a shape/design/
  // transform change, and never a second AI call.
  React.useEffect(() => {
    if (!masterSketch) return;
    let cancelled = false;
    extractSilhouetteContour(masterSketch)
      .then((result) => {
        if (!cancelled) setContour(result);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setContourError(error instanceof Error ? error.message : 'Could not trace the silhouette outline from this sketch.');
      });
    return () => {
      cancelled = true;
    };
  }, [masterSketch]);

  const handleFileSelected = (selected: File) => {
    if (originalImage) URL.revokeObjectURL(originalImage);
    setFile(selected);
    setCrop(FULL_CROP);
    setOriginalImage(URL.createObjectURL(selected));
    setErrorMessage(null);
    setStatus('idle');
    // A new photo means any previous sketch no longer corresponds to it.
    setMasterSketch(null);
  };

  /**
   * Operation 1. The only function in this file that calls the AI, and the
   * only place `masterSketch` is ever set from a network response. Guarded
   * against double-clicks, a missing category, and superseded responses.
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
    // Only the boxed part of the photo is ever sent — see lib/photo-crop.ts.
    let cropped: File;
    try {
      cropped = await cropImageFile(file, crop);
    } catch {
      if (requestId !== requestIdRef.current) return;
      setErrorMessage('Could not crop the photo. Please try a different photo.');
      setStatus('error');
      return;
    }
    try {
      const formData = new FormData();
      formData.set('file', cropped);
      formData.set('category', selectedCategory);
      const response = await fetch('/api/generate-image', { method: 'POST', body: formData });
      const body = (await response.json().catch(() => null)) as
        | { success: true; image: string }
        | { success: false; error: string }
        | null;
      if (requestId !== requestIdRef.current) return; // superseded by a newer request
      if (!body || !response.ok || !body.success) {
        setErrorMessage(body && !body.success ? body.error : 'Unable to generate the image. Please try again.');
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
    setSelectedShape(DEFAULT_SHAPE_ID);
    setSelectedMaterial(DEFAULT_MATERIAL_ID);
    setTransform(DEFAULT_TRANSFORM);
    setSelectedDesignType(DEFAULT_DESIGN_TYPE);
    setRimColor(DEFAULT_RIM_COLOR_ID);
    setContour(null);
    setContourError(null);
    clearPendantSession();
  };

  const isGenerating = status === 'generating';
  const hasSketch = masterSketch !== null;
  const activeContour = selectedDesignType === 'edge-cut' ? contour : null;
  const shapeSupportsRim = selectedDesignType === 'standard' && PENDANT_SHAPES[selectedShape].supportsRim;
  const effectiveRim: RimColorId = shapeSupportsRim ? rimColor : 'none';
  const designLabel =
    selectedDesignType === 'edge-cut'
      ? `${PENDANT_CATEGORIES[activeCategoryId].label} · Silhouette Cut`
      : `${PENDANT_SHAPES[selectedShape].label} pendant`;

  const previewProps = {
    sketch: masterSketch,
    shape: selectedShape,
    category: activeCategoryId,
    designType: selectedDesignType,
    contour: activeContour,
    rimColor: effectiveRim,
    transform,
  };

  return (
    <main className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-10 px-4 py-12 sm:px-6">
      <header className="flex flex-col gap-2 text-center">
        <h1 className="text-2xl font-semibold text-slate-900 sm:text-3xl">Custom Pendant Design</h1>
        <p className="text-sm text-slate-500">
          Upload a customer&apos;s photo once — preview every pendant and metal instantly, then render the product photo
          and download the production files.
        </p>
      </header>

      {errorMessage && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {errorMessage}
        </div>
      )}

      <Section step={1} title="Upload Photo">
        {!hasSketch ? (
          <div className="flex flex-col gap-6">
            {!originalImage ? (
              <ImageUploader onFileSelected={handleFileSelected} onValidationError={setErrorMessage} />
            ) : (
              <>
                <div className="mx-auto w-full max-w-md">
                  <PhotoCropper src={originalImage} crop={crop} onChange={setCrop} disabled={isGenerating} />
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

      {!hasSketch && originalImage && (
        <Section step={2} title="Choose Pendant Category">
          <div className="flex flex-col gap-4">
            <PendantCategoryPicker value={selectedCategory} onChange={setSelectedCategory} categories={GENERATION_CATEGORY_LIST} />
            <p className="text-xs text-slate-400">
              This controls how much of the photo the AI includes in the sketch — the pendant type and shape are chosen after
              generation.
            </p>
            <div className="flex flex-col items-center gap-3">
              <button
                type="button"
                onClick={generateSketch}
                disabled={isGenerating || !selectedCategory}
                className="inline-flex items-center justify-center gap-2 rounded-full bg-slate-900 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Generate Sketch
              </button>
              {!selectedCategory && (
                <p className="text-center text-xs text-amber-600">Please select a pendant category before generating your design.</p>
              )}
            </div>
            {isGenerating && <GenerationProgress />}
          </div>
        </Section>
      )}

      {hasSketch && (
        <>
          <Section step={3} title="Master Sketch">
            <div className="flex flex-col gap-4">
              <div className="mx-auto w-full max-w-xs">
                <GeneratedImage image={masterSketch} />
              </div>
              <p className="flex items-center justify-center gap-1.5 text-sm font-medium text-emerald-700">
                <span aria-hidden>✓</span> Sketch generated as a {PENDANT_CATEGORIES[activeCategoryId].label} — reused for every
                pendant and metal below.
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

          <Section step={4} title="Choose Pendant Type">
            <div className="flex flex-col gap-4">
              <PendantDesignPicker value={selectedDesignType} onChange={setSelectedDesignType} />
              {selectedDesignType === 'edge-cut' && contourError && (
                <p role="alert" className="text-xs text-red-600">
                  {contourError} Shape pendants are still fully available.
                </p>
              )}
              {selectedDesignType === 'edge-cut' && !contour && !contourError && (
                <p className="text-xs text-slate-400">Tracing the cut outline from the sketch…</p>
              )}
              {selectedDesignType === 'standard' && (
                <>
                  <PendantShapePicker value={selectedShape} onChange={setSelectedShape} />
                  {shapeSupportsRim && <RimColorPicker value={rimColor} onChange={setRimColor} />}
                </>
              )}
            </div>
          </Section>

          <Section step={5} title="Choose Metal">
            <MaterialPicker value={selectedMaterial} onChange={setSelectedMaterial} />
          </Section>

          <Section step={6} title="Pendant Preview">
            <div className="flex flex-col items-center gap-8">
              <PendantPreview {...previewProps} material={selectedMaterial} size={280} />
              <div className="flex w-full flex-col gap-3 border-t border-slate-100 pt-6">
                <p className="text-center text-xs font-medium uppercase tracking-wide text-slate-400">Compare metals — {designLabel}</p>
                <div className="flex items-start justify-center gap-8">
                  {PENDANT_MATERIAL_LIST.map((material) => (
                    <div key={material.id} className="flex flex-col items-center gap-2">
                      <PendantPreview
                        {...previewProps}
                        material={material.id}
                        size={120}
                        className={material.id === selectedMaterial ? 'rounded-lg ring-2 ring-slate-900 ring-offset-2' : ''}
                      />
                      <span className="text-xs font-medium text-slate-500">{material.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </Section>

          <Section step={7} title="Customize Image">
            <PendantControls transform={transform} onChange={setTransform} />
          </Section>

          <Section step={8} title="Product Mockup">
            <MockupPanel {...previewProps} sketch={masterSketch} />
          </Section>

          <Section step={9} title="Manufacturing Files">
            <ExportPanel {...previewProps} sketch={masterSketch} material={selectedMaterial} />
          </Section>

          <Section step={10} title="Download Preview Image">
            <DownloadPanel {...previewProps} sketch={masterSketch} material={selectedMaterial} />
          </Section>
        </>
      )}
    </main>
  );
}

function Section({ step, title, children }: { step: number; title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border-t border-slate-200 pt-8 first:border-t-0 first:pt-0">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
        {step}. {title}
      </h2>
      {children}
    </section>
  );
}

function SummaryRow({ label, action }: { label: string; action: { label: string; onClick: () => void } }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
      <span className="flex items-center gap-1.5 text-sm text-slate-600">
        <span aria-hidden className="text-emerald-600">
          ✓
        </span>
        {label}
      </span>
      <button type="button" onClick={action.onClick} className="text-xs font-medium text-slate-500 underline-offset-4 hover:text-slate-700 hover:underline">
        {action.label}
      </button>
    </div>
  );
}
