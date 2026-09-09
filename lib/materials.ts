/**
 * Pendant material registry.
 *
 * Switching material only changes which gradient the canvas renderer fills
 * the pendant body with — it never touches `generatedSketch` and never calls
 * the AI. Add a new metal by adding an entry here.
 */

export type MaterialId = 'silver' | 'gold' | 'black-white';

export interface PendantMaterial {
  id: MaterialId;
  label: string;
  /** Five-stop brushed-metal gradient: highlight/mid/highlight/mid/shadow. */
  gradient: [string, string, string, string, string];
  /**
   * Standard Pendant's rim-stroke colour; also the flat tint colour Edge Cut
   * recolours its artwork to when `tintArtwork` is true (see
   * `getTintedInkMask` in components/PendantPreview.tsx).
   */
  rim: string;
  /** Swatch shown in the material picker. */
  swatch: string;
  /**
   * Whether Edge Cut's flat artwork should be recoloured to `rim` (gold and
   * silver need this — the sketch's native ink must become a metal tone) or
   * drawn exactly as the sketch itself renders it (black & white: the
   * sketch's own grayscale shading already *is* the desired look, and
   * flattening it to solid black loses that shading — see
   * `paintFlatArtwork` in components/PendantPreview.tsx).
   */
  tintArtwork: boolean;
}

export const PENDANT_MATERIALS: Record<MaterialId, PendantMaterial> = {
  silver: {
    id: 'silver',
    label: 'Silver',
    gradient: ['#f2f4f6', '#b9bec4', '#f2f4f6', '#b9bec4', '#6f7479'],
    rim: '#8d9298',
    swatch: '#c8ccd1',
    tintArtwork: true,
  },
  gold: {
    id: 'gold',
    label: 'Gold',
    gradient: ['#f7e3a1', '#d8ab3f', '#f7e3a1', '#d8ab3f', '#8a6414'],
    rim: '#a97f22',
    swatch: '#d4af37',
    tintArtwork: true,
  },
  'black-white': {
    id: 'black-white',
    label: 'Black & White',
    // A genuine white-to-black monochrome gradient for Standard Pendant's
    // plate. `rim` (pure black) is still used for Standard Pendant's
    // decorative rim stroke — but `tintArtwork: false` means Edge Cut leaves
    // the artwork untouched instead of flattening it to `rim`, since the
    // sketch's own grayscale shading is already the desired black & white
    // look.
    gradient: ['#ffffff', '#a8a8a8', '#ffffff', '#4d4d4d', '#000000'],
    rim: '#000000',
    swatch: '#808080',
    tintArtwork: false,
  },
};

export const PENDANT_MATERIAL_LIST: PendantMaterial[] = Object.values(PENDANT_MATERIALS);

export function isMaterialId(value: string): value is MaterialId {
  return value in PENDANT_MATERIALS;
}
