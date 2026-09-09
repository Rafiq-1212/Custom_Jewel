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

import { isMaterialId, type MaterialId } from './materials';
import {
  DEFAULT_DESIGN_TYPE,
  DEFAULT_EDGE_CUT_STYLE,
  isDesignType,
  isEdgeCutStyle,
  type DesignType,
  type EdgeCutStyle,
} from './pendant-geometry';
import { DEFAULT_CATEGORY_ID, isCategoryId, type CategoryId } from './pendant-categories';
import { DEFAULT_TRANSFORM, isShapeId, type PendantTransform, type ShapeId } from './pendant-shapes';

const SKETCH_KEY = 'pendant-designer:sketch';
const PREFS_KEY = 'pendant-designer:prefs';

interface StoredPrefs {
  selectedCategory: CategoryId;
  selectedShape: ShapeId;
  selectedMaterial: MaterialId;
  transform: PendantTransform;
  designType: DesignType;
  edgeCutStyle: EdgeCutStyle;
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

function isPendantTransform(value: unknown): value is PendantTransform {
  if (!value || typeof value !== 'object') return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.zoom === 'number' &&
    typeof t.x === 'number' &&
    typeof t.y === 'number' &&
    typeof t.rotation === 'number'
  );
}

export function loadPrefs(): StoredPrefs | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(PREFS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPrefs>;
    if (
      typeof parsed.selectedShape !== 'string' ||
      !isShapeId(parsed.selectedShape) ||
      typeof parsed.selectedMaterial !== 'string' ||
      !isMaterialId(parsed.selectedMaterial) ||
      !isPendantTransform(parsed.transform)
    ) {
      return null;
    }
    // Category, designType and edgeCutStyle were each added after this
    // storage format first shipped — fall back rather than discarding an
    // otherwise-valid, already-persisted session just because it predates a
    // field.
    const selectedCategory =
      typeof parsed.selectedCategory === 'string' && isCategoryId(parsed.selectedCategory)
        ? parsed.selectedCategory
        : DEFAULT_CATEGORY_ID;
    const designType =
      typeof parsed.designType === 'string' && isDesignType(parsed.designType)
        ? parsed.designType
        : DEFAULT_DESIGN_TYPE;
    const edgeCutStyle =
      typeof parsed.edgeCutStyle === 'string' && isEdgeCutStyle(parsed.edgeCutStyle)
        ? parsed.edgeCutStyle
        : DEFAULT_EDGE_CUT_STYLE;
    return {
      selectedCategory,
      selectedShape: parsed.selectedShape,
      selectedMaterial: parsed.selectedMaterial,
      transform: parsed.transform,
      designType,
      edgeCutStyle,
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
