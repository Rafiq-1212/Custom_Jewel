/**
 * Pendant material registry — the two metals the True Tribute catalogue
 * actually sells every photo pendant in: Silver and Gold.
 *
 * Switching material only changes which colours the canvas renderer paints
 * with and which wording the AI mockup prompt uses — it never touches the
 * master sketch and never regenerates it. Add a new metal by adding an entry.
 */

export type MaterialId = 'silver' | 'gold';

export interface PendantMaterial {
  id: MaterialId;
  label: string;
  /** Five-stop brushed-metal gradient: highlight/mid/highlight/mid/shadow. */
  gradient: [string, string, string, string, string];
  /**
   * Shape Pendant's rim-stroke colour; also the flat colour Silhouette Cut
   * recolours its artwork to (see `getTintedInkMask` in
   * components/PendantPreview.tsx).
   */
  rim: string;
  /** Swatch shown in the material picker. */
  swatch: string;
  /** Single flat plate colour for the composite handed to the AI mockup renderer (lib/mockup.ts). */
  flat: string;
  /** How the AI mockup prompt names this metal. */
  mockupDescription: string;
  /**
   * How the metal's surface should be lit in the mockup. Written per metal
   * because they fail in opposite ways: asked for "polished silver" the model
   * renders a white mirror, and the engraving washes out to thin grey lines
   * on it. Gold has its own colour to sit against, so it never did that.
   */
  mockupFinish: string;
  /**
   * How the engraved lines look on this metal. Real engraved silver is
   * oxidised dark in the cuts, which is both what the client's own photos
   * show and what keeps the artwork readable against a bright surface.
   */
  mockupEngraving: string;
}

export const PENDANT_MATERIALS: Record<MaterialId, PendantMaterial> = {
  silver: {
    id: 'silver',
    label: 'Silver',
    gradient: ['#f2f4f6', '#b9bec4', '#f2f4f6', '#b9bec4', '#6f7479'],
    rim: '#8d9298',
    swatch: '#c8ccd1',
    flat: '#c9cdd2',
    mockupDescription: '925 sterling silver',
    mockupFinish:
      'Bright white metal with a soft satin sheen, like a jeweller\'s lightly polished silver: gentle graduated reflections across the plate, a slightly darker tone towards the edges and a soft bevel catching the light. Do NOT render it as a blown-out white mirror, and keep the whole plate clearly darker than the cream background so the metal reads as metal.',
    mockupEngraving:
      'The cuts are oxidised almost black, the way engraved silver is antiqued, so every line reads as a deep dark stroke against the bright metal.',
  },
  gold: {
    id: 'gold',
    label: 'Gold',
    gradient: ['#f7e3a1', '#d8ab3f', '#f7e3a1', '#d8ab3f', '#8a6414'],
    rim: '#a97f22',
    swatch: '#d4af37',
    flat: '#d8ab3f',
    mockupDescription: 'polished 22k yellow gold',
    mockupFinish:
      'Warm yellow gold with realistic polished reflections, a slightly deeper tone towards the edges and a soft bevel catching the light.',
    mockupEngraving:
      'The cuts are dark brown-black, the way engraved gold is oxidised, so every line reads as a deep dark stroke against the warm metal.',
  },
};

export const PENDANT_MATERIAL_LIST: PendantMaterial[] = Object.values(PENDANT_MATERIALS);

export const DEFAULT_MATERIAL_ID: MaterialId = 'silver';

export function isMaterialId(value: string): value is MaterialId {
  return value in PENDANT_MATERIALS;
}

/* -------------------------------------------------------------------------- */
/* Enamel rim — the catalogue's "Heart with Color" / "Round with Color".      */
/* -------------------------------------------------------------------------- */

export type RimColorId = 'none' | 'red' | 'blue';

export interface RimColor {
  id: RimColorId;
  label: string;
  /** `null` for no rim. */
  hex: string | null;
}

export const RIM_COLORS: Record<RimColorId, RimColor> = {
  none: { id: 'none', label: 'Plain metal', hex: null },
  red: { id: 'red', label: 'Red enamel rim', hex: '#d62828' },
  blue: { id: 'blue', label: 'Blue enamel rim', hex: '#1d4ed8' },
};

export const RIM_COLOR_LIST: RimColor[] = Object.values(RIM_COLORS);

export const DEFAULT_RIM_COLOR_ID: RimColorId = 'none';

/** Width of the enamel band, in the shared 100 x 116 viewBox units, measured inward from the plate edge. */
export const RIM_BAND_WIDTH = 5;

export function isRimColorId(value: string): value is RimColorId {
  return value in RIM_COLORS;
}
