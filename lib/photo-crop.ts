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
const MAX_CROP_EDGE = 4000;

export async function cropImageFile(file: File, crop: CropRect): Promise<File> {
  if (isFullCrop(crop)) return file;

  const url = URL.createObjectURL(file);
  try {
    const image = await decodeImage(url);
    const sx = Math.round(crop.x * image.naturalWidth);
    const sy = Math.round(crop.y * image.naturalHeight);
    const sw = Math.max(1, Math.round(crop.width * image.naturalWidth));
    const sh = Math.max(1, Math.round(crop.height * image.naturalHeight));

    // iPhones give up on a canvas over about 16 MP; the drawing needs far less.
    const fit = Math.min(1, MAX_CROP_EDGE / Math.max(sw, sh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sw * fit));
    canvas.height = Math.max(1, Math.round(sh * fit));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas is not available in this browser.');
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

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

/**
 * A request to the server can carry at most 4.5 MB (Vercel's limit); a
 * bigger photo is turned away before it arrives, and the customer saw only
 * "Something went wrong making the sketch". Phone photos and crops of them
 * are often 5 to 8 MB, so anything over this is scaled down here first.
 */
const MAX_SEND_BYTES = 3.8 * 1024 * 1024;
/** Longest side of a scaled-down photo, then a smaller one if that is still too big. Far more than the drawing needs. */
const SEND_EDGES = [3072, 2400, 1800];

/** The photo as it is when small enough to send; otherwise scaled down and saved as a JPEG. */
export async function fitForUpload(file: File): Promise<File> {
  if (file.size <= MAX_SEND_BYTES) return file;
  const url = URL.createObjectURL(file);
  try {
    const image = await decodeImage(url);
    let smallest: Blob | null = null;
    for (const edge of SEND_EDGES) {
      const scale = Math.min(1, edge / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return file;
      // A JPEG has no transparency: a see-through PNG goes on white, not black.
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
      if (!blob) return file;
      smallest = blob;
      if (blob.size <= MAX_SEND_BYTES) break;
    }
    const baseName = file.name.replace(/\.[^.]+$/, '') || 'photo';
    return smallest ? new File([smallest], `${baseName}.jpg`, { type: 'image/jpeg' }) : file;
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(url);
  }
}
