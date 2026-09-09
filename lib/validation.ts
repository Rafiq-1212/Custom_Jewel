export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AcceptedImageType = (typeof ACCEPTED_IMAGE_TYPES)[number];


export const ACCEPTED_IMAGE_EXTENSIONS = '.jpg,.jpeg,.png,.webp';
export const ACCEPTED_IMAGE_LABEL = 'JPG, PNG or WEBP';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB
export const MAX_IMAGE_LABEL = '8MB';

export type ValidationErrorCode = 'NO_FILE' | 'INVALID_TYPE' | 'TOO_LARGE';

export interface ValidationFailure {
  ok: false;
  code: ValidationErrorCode;
  message: string;
}

export interface ValidationSuccess {
  ok: true;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

function fail(code: ValidationErrorCode, message: string): ValidationFailure {
  return { ok: false, code, message };
}

function isAcceptedType(type: string): type is AcceptedImageType {
  return (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(type);
}

/**
 * Quick check against declared metadata only (`File.type`, `File.size`).
 * Used by the uploader before it even reads the file, for instant feedback.
 */
export function quickValidate(file: File | null | undefined): ValidationResult {
  if (!file) return fail('NO_FILE', 'No image selected.');
  if (!isAcceptedType(file.type)) {
    return fail('INVALID_TYPE', `Unsupported image format. Please use ${ACCEPTED_IMAGE_LABEL}.`);
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return fail('TOO_LARGE', `Image is too large. Please use a photo under ${MAX_IMAGE_LABEL}.`);
  }
  return { ok: true };
}

/**
 * Magic-byte sniff for the three accepted formats.
 *
 * A browser-reported `File.type` (and an HTTP `Content-Type` header) are both
 * just labels the client attached — neither proves what the bytes actually
 * are. This is what the server checks before anything is sent to Gemini.
 */
export function sniffImageType(bytes: Uint8Array): AcceptedImageType | null {
  if (bytes.length < 12) return null;

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }

  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (pngSignature.every((byte, index) => bytes[index] === byte)) {
    return 'image/png';
  }

  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.subarray(start, end));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    return 'image/webp';
  }

  return null;
}

/** The real check: declared size, then actual content by magic bytes. */
export function validateImageBytes(bytes: Uint8Array, declaredSize: number): ValidationResult {
  if (declaredSize > MAX_IMAGE_BYTES || bytes.byteLength > MAX_IMAGE_BYTES) {
    return fail('TOO_LARGE', `Image is too large. Please use a photo under ${MAX_IMAGE_LABEL}.`);
  }
  if (!sniffImageType(bytes)) {
    return fail('INVALID_TYPE', `Unsupported image format. Please use ${ACCEPTED_IMAGE_LABEL}.`);
  }
  return { ok: true };
}
