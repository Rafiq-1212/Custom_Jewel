/**
 * The touched-up photo, kept for a little while so a redraw doesn't pay for
 * it twice.
 *
 * A sketch is three chargeable steps (lib/sketch-pipeline.ts): the photo
 * edit, the questions about the faces, and the drawing. Only the last of
 * those is a drawing — the first two are about the PHOTOGRAPH, and the
 * photograph does not change when someone asks for the sketch again. Measured
 * on a real request, redoing them costs $0.0724 of a $0.2268 sketch, so a
 * redraw that reuses them is 32% cheaper for an identical result.
 *
 * Kept in the server's own memory, keyed by the bytes of the photo. That has
 * two consequences worth being plain about:
 *
 *   - It is per instance and it is lost on a cold start. A miss is not a
 *     failure; it just means the sketch costs what it used to.
 *   - Two requests carrying the same photograph share an entry, whoever sent
 *     them. The key is a hash of the exact bytes, so this only happens for
 *     byte-identical uploads, and all that is shared is a cleaned-up copy of
 *     the same picture the second request already holds.
 *
 * The entries are big (a 1K PNG, a megabyte or two), so the cache is small
 * and short-lived on purpose: a handful of photos, half an hour, which covers
 * an operator working through one customer's photo and nothing more.
 */

import { createHash } from 'node:crypto';
import type { FaceCounts } from './face-marks';

if (typeof window !== 'undefined') {
  throw new Error('lib/photo-cache.ts was imported into a browser bundle. This module is server-only.');
}

/** Everything the drawing step needs that depends on the photo, not on the drawing. */
export interface PreparedPhoto {
  /** Touched up, and for Face Pendant already cut off below the jaw. */
  photo: Buffer;
  faces: FaceCounts;
}

const TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 6;

interface Entry {
  value: PreparedPhoto;
  expires: number;
}

const entries = new Map<string, Entry>();

/**
 * The framing is part of the key as well as the bytes: Face Pendant cuts the
 * photo below the jaw, so the same photograph prepared for a Face Pendant is
 * not the photo a Family Pendant should be drawn from.
 */
export function preparedPhotoKey(imageBytes: Uint8Array, category: string): string {
  return `${createHash('sha256').update(imageBytes).digest('hex')}:${category}`;
}

function sweep(): void {
  const now = Date.now();
  for (const [key, entry] of entries) {
    if (entry.expires <= now) entries.delete(key);
  }
}

export function getPreparedPhoto(key: string): PreparedPhoto | null {
  sweep();
  const entry = entries.get(key);
  if (!entry) return null;
  // Re-insert so the most recently used entry is the last one evicted.
  entries.delete(key);
  entries.set(key, entry);
  return entry.value;
}

export function setPreparedPhoto(key: string, value: PreparedPhoto): void {
  sweep();
  entries.delete(key);
  entries.set(key, { value, expires: Date.now() + TTL_MS });
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
}
