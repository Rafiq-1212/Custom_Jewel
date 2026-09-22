/**
 * Session persistence for the pendant designer.
 *
 * "Preferably persisted so the user doesn't lose it during customization" —
 * `sessionStorage` survives a reload within the tab without needing a
 * backend. The sketch (a multi-hundred-KB to few-MB data URL) is stored under
 * its own key, written only when it actually changes; shape/material/
 * transform live under a second, tiny key so dragging a slider doesn't
 * re-serialize the sketch on every tick.
 *
 * Every call is wrapped defensively: private browsing, a full quota, or
 * `sessionStorage` simply not existing must never crash the page — losing
 * the persistence is an acceptable degradation, losing the app is not.
 */

import { DEFAULT_MATERIAL_ID, DEFAULT_RIM_COLOR_ID, isMaterialId, isRimColorId, type MaterialId, type RimColorId } from './materials';
import { DEFAULT_DESIGN_TYPE, isDesignType, type DesignType } from './pendant-geometry';
import { DEFAULT_CATEGORY_ID, isCategoryId, type CategoryId } from './pendant-categories';
import { DEFAULT_SHAPE_ID, DEFAULT_TRANSFORM, isShapeId, type PendantTransform, type ShapeId } from './pendant-shapes';

/**
 * Which resolution the stored sketch was drawn at, so a reload still knows a
 * draft is a draft and can offer to redraw it properly. Declared here rather
 * than imported from lib/sketch-pipeline.ts, which is server-only and must
 * never be pulled into the browser bundle.
 */
export type SketchQuality = 'draft' | 'final';

function isSketchQuality(value: string): value is SketchQuality {
  return value === 'draft' || value === 'final';
}

const SKETCH_KEY = 'pendant-designer:sketch';
const PREFS_KEY = 'pendant-designer:prefs';

export interface StoredPrefs {
  selectedCategory: CategoryId;
  selectedShape: ShapeId;
  selectedMaterial: MaterialId;
  transform: PendantTransform;
  designType: DesignType;
  rimColor: RimColorId;
  sketchQuality: SketchQuality;
}

function getStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function saveSketch(sketch: string | null): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    if (sketch) storage.setItem(SKETCH_KEY, sketch);
    else storage.removeItem(SKETCH_KEY);
  } catch {
    // Quota exceeded or storage disabled — the sketch just won't survive a
    // reload this time. The in-memory state the user is actively using is
    // unaffected either way.
  }
}

export function loadSketch(): string | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    return storage.getItem(SKETCH_KEY);
  } catch {
    return null;
  }
}

export function savePrefs(prefs: StoredPrefs): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Non-critical: worst case the customer re-picks shape/material/fit.
  }
}

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 5;

function isPendantTransform(value: unknown): value is PendantTransform {
  if (!value || typeof value !== 'object') return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.zoom === 'number' &&
    t.zoom >= MIN_ZOOM &&
    t.zoom <= MAX_ZOOM &&
    Number.isFinite(t.x) &&
    Number.isFinite(t.y) &&
    Number.isFinite(t.rotation)
  );
}

/**
 * Every field falls back to its default individually rather than the whole
 * record being discarded: the catalogue of shapes and metals has changed
 * since this format first shipped (e.g. a persisted 'diamond' shape or
 * 'black-white' metal no longer exists), and a stale pick in one field is no
 * reason to lose the customer's otherwise-valid session.
 */
export function loadPrefs(): StoredPrefs | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(PREFS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPrefs>;
    const pick = <T extends string>(value: unknown, guard: (v: string) => v is T, fallback: T): T =>
      typeof value === 'string' && guard(value) ? value : fallback;
    return {
      selectedCategory: pick(parsed.selectedCategory, isCategoryId, DEFAULT_CATEGORY_ID),
      selectedShape: pick(parsed.selectedShape, isShapeId, DEFAULT_SHAPE_ID),
      selectedMaterial: pick(parsed.selectedMaterial, isMaterialId, DEFAULT_MATERIAL_ID),
      transform: isPendantTransform(parsed.transform) ? parsed.transform : DEFAULT_TRANSFORM,
      designType: pick(parsed.designType, isDesignType, DEFAULT_DESIGN_TYPE),
      rimColor: pick(parsed.rimColor, isRimColorId, DEFAULT_RIM_COLOR_ID),
      // A session saved before draft mode existed holds a 4K sketch.
      sketchQuality: pick(parsed.sketchQuality, isSketchQuality, 'final'),
    };
  } catch {
    return null;
  }
}

export function clearPendantSession(): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(SKETCH_KEY);
    storage.removeItem(PREFS_KEY);
  } catch {
    // Nothing to do — worst case stale data lingers until the tab closes.
  }
}

export { DEFAULT_TRANSFORM };
