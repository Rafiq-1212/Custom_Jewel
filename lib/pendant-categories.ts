/**
 * Pendant category registry — framing presets, not AI generations.
 *
 * A category answers "what kind of pendant is this" (Face, Couple, Family,
 * Pet, ...) as distinct from `shape`, which answers "what outline does it
 * have" (Heart, Diamond, ...). The two are independent axes on purpose — the
 * catalogue sells a Family Pendant in a heart outline just as readily as a
 * round one.
 *
 * A category is nothing more than a default framing (`engravingArea`, the
 * box the artwork is fit into) and a starting `transform`. Selecting one is a
 * `setSelectedCategory` call plus applying those two defaults — no AI call,
 * no image processing, no exception to the rule. The customer's zoom/
 * position/rotation controls still work exactly the same afterwards; the
 * category only decides where they start from.
 */

import { DEFAULT_TRANSFORM, PENDANT_VIEWBOX, type PendantTransform } from './pendant-shapes';

export type CategoryId = 'face' | 'half-size' | 'couple' | 'family' | 'pet' | 'heart' | 'round' | 'oval';

export interface PendantCategory {
  id: CategoryId;
  label: string;
  description: string;
  /**
   * The box the artwork is fit into, in the shared 100 x 116 viewBox — the
   * same coordinate space every shape's own `engravingArea` uses, so this can
   * be swapped in for it regardless of which shape is selected.
   */
  engravingArea: { x: number; y: number; width: number; height: number };
  /** Starting point for the zoom/position/rotation controls. */
  defaultTransform: PendantTransform;
}

const { width: VB, height: VH } = PENDANT_VIEWBOX;

export const PENDANT_CATEGORIES: Record<CategoryId, PendantCategory> = {
  face: {
    id: 'face',
    label: 'Face Pendant',
    description: 'Just the face, up close.',
    engravingArea: { x: VB * 0.3, y: VH * 0.32, width: VB * 0.4, height: VH * 0.36 },
    defaultTransform: { ...DEFAULT_TRANSFORM, zoom: 1.35 },
  },
  'half-size': {
    id: 'half-size',
    label: 'Half Size Pendant',
    description: 'Head and shoulders, down to the chest.',
    engravingArea: { x: VB * 0.26, y: VH * 0.28, width: VB * 0.48, height: VH * 0.5 },
    defaultTransform: { ...DEFAULT_TRANSFORM, zoom: 1.1 },
  },
  couple: {
    id: 'couple',
    label: 'Couple Pendant',
    description: 'Two people together.',
    engravingArea: { x: VB * 0.16, y: VH * 0.3, width: VB * 0.68, height: VH * 0.42 },
    defaultTransform: { ...DEFAULT_TRANSFORM, zoom: 0.9 },
  },
  family: {
    id: 'family',
    label: 'Family Pendant',
    description: 'Three or more people together.',
    engravingArea: { x: VB * 0.12, y: VH * 0.28, width: VB * 0.76, height: VH * 0.46 },
    defaultTransform: { ...DEFAULT_TRANSFORM, zoom: 0.8 },
  },
  pet: {
    id: 'pet',
    label: 'Pet Pendant',
    description: 'Your pet\'s head and shoulders.',
    engravingArea: { x: VB * 0.28, y: VH * 0.3, width: VB * 0.44, height: VH * 0.4 },
    defaultTransform: { ...DEFAULT_TRANSFORM, zoom: 1.25 },
  },
  heart: {
    id: 'heart',
    label: 'Heart Pendant',
    description: 'A portrait for a heart-shaped pendant.',
    engravingArea: { x: VB * 0.27, y: VH * 0.39, width: VB * 0.46, height: VH * 0.4 },
    defaultTransform: DEFAULT_TRANSFORM,
  },
  round: {
    id: 'round',
    label: 'Round Pendant',
    description: 'A portrait for a round pendant.',
    engravingArea: { x: VB * 0.17, y: VH * 0.28, width: VB * 0.66, height: VH * 0.57 },
    defaultTransform: DEFAULT_TRANSFORM,
  },
  oval: {
    id: 'oval',
    label: 'Oval Pendant',
    description: 'A portrait for an oval pendant.',
    engravingArea: { x: VB * 0.24, y: VH * 0.29, width: VB * 0.52, height: VH * 0.55 },
    defaultTransform: DEFAULT_TRANSFORM,
  },
};

export const PENDANT_CATEGORY_LIST: PendantCategory[] = Object.values(PENDANT_CATEGORIES);

export const DEFAULT_CATEGORY_ID: CategoryId = 'heart';

export function isCategoryId(value: string): value is CategoryId {
  return value in PENDANT_CATEGORIES;
}

/**
 * The categories offered to the customer BEFORE Gemini generation — each one
 * has a matching Gemini framing prompt (see `CATEGORY_FRAMING_PROMPTS` in
 * lib/gemini.ts), since this choice now controls what Gemini generates, not
 * only how the resulting sketch is framed on screen afterwards.
 *
 * `heart` / `round` / `oval` predate that: they're framing-only presets tied
 * to the shape catalogue, with no subject-content prompt of their own, so
 * they're intentionally excluded from this list. They remain valid
 * `CategoryId`s — `PENDANT_CATEGORIES` still has entries for them — purely so
 * a session saved before this change still loads correctly.
 */
export const GENERATION_CATEGORY_IDS: CategoryId[] = ['face', 'half-size', 'couple', 'family', 'pet'];

export const GENERATION_CATEGORY_LIST: PendantCategory[] = GENERATION_CATEGORY_IDS.map(
  (id) => PENDANT_CATEGORIES[id],
);
