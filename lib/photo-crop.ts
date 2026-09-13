'use client';

/**
 * Pre-generation crop of the uploaded photo.
 *
 * Gemini draws what it is shown, and prompting alone is only partly
 * reliable at leaving things out — verified on a father-and-toddler selfie
 * where the outstretched arm dominated the frame and stayed in two runs out
 * of three. Letting the operator draw a box on the photo first is
 * deterministic: only the boxed pixels are ever sent, so an arm, a stranger
 * or a busy background can't make it into the sketch at all. Entirely
 * client-side (canvas), no extra AI call.
 */

/** A crop rectangle as fractions of the photo's width/height, all in 0..1. */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const FULL_CROP: CropRect = { x: 0, y: 0, width: 1, height: 1 };

/** Smallest crop allowed, as a fraction of each dimension — enough to still contain a face. */
export const MIN_CROP_FRACTION = 0.08;

export function isFullCrop(crop: CropRect): boolean {
  return crop.x === 0 && crop.y === 0 && crop.width === 1 && crop.height === 1;
}

/** Keeps a rect inside 0..1 and at least the minimum size. */
export function clampCrop(crop: CropRect): CropRect {
  const width = Math.min(1, Math.max(MIN_CROP_FRACTION, crop.width));
  const height = Math.min(1, Math.max(MIN_CROP_FRACTION, crop.height));
  const x = Math.min(1 - width, Math.max(0, crop.x));
  const y = Math.min(1 - height, Math.max(0, crop.y));
  return { x, y, width, height };
}

function decodeImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not decode the photo.'));
    image.src = src;
  });
}

/**
 * Returns the photo cropped to `crop`, as a new File the upload route
 * accepts as-is. A full crop returns the original file untouched — no
 * re-encoding, no quality loss. Otherwise the crop is re-encoded as JPEG
 * (or PNG for PNG sources, to keep any transparency), which the server
 * re-validates by its actual bytes exactly like a direct upload.
 */
export async function cropImageFile(file: File, crop: CropRect): Promise<File> {
  if (isFullCrop(crop)) return file;

  const url = URL.createObjectURL(file);
  try {
    const image = await decodeImage(url);
    const sx = Math.round(crop.x * image.naturalWidth);
    const sy = Math.round(crop.y * image.naturalHeight);
    const sw = Math.max(1, Math.round(crop.width * image.naturalWidth));
    const sh = Math.max(1, Math.round(crop.height * image.naturalHeight));

    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas is not available in this browser.');
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);

    const isPng = file.type === 'image/png';
    const mimeType = isPng ? 'image/png' : 'image/jpeg';
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error('Could not crop the photo.'))),
        mimeType,
        isPng ? undefined : 0.92,
      );
    });
    const baseName = file.name.replace(/\.[^.]+$/, '') || 'photo';
    return new File([blob], `${baseName}-crop.${isPng ? 'png' : 'jpg'}`, { type: mimeType });
  } finally {
    URL.revokeObjectURL(url);
  }
}
