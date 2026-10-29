'use client';

/**
 * One shop customer's design, from photo to product photo, in steps that can
 * be picked up again. The customer may close the window or go on to another
 * page of the shop while it is made: after every step the design's state is
 * handed to the shop page (components/try/shop.ts), which keeps it and, on
 * whichever page is open, starts this page again in the background to carry
 * on, then shows a notification when it is ready (shopify/true-tribute-try.js).
 *
 * The drawing and the product photo are batch jobs the server keeps; only
 * their names are needed to wait for them again. The photo itself is kept in
 * this page's own storage, for the archive and for a redo of a drawing that
 * came back out of frame.
 */

import { designRef } from '@/lib/design-ref';
import { extractSilhouetteContour } from '@/lib/edge-cut-contour';
import { runMockup } from '@/lib/mockup-client';
import { PENDANT_CATEGORIES } from '@/lib/pendant-categories';
import { DEFAULT_TRANSFORM, PENDANT_SHAPES } from '@/lib/pendant-shapes';
import type { ShopProduct } from '@/lib/shop-products';
import { runSketch, type SubmittedInk } from '@/lib/sketch-client';
import type { Stage } from './Progress';

export type Metal = 'gold' | 'silver';

/** A design being made, as the shop page keeps it. */
export interface Pending {
  id: string;
  product: ShopProduct;
  /** The product page it was started on, to go back to. */
  handle: string | null;
  title: string | null;
  url: string | null;
  metal: Metal;
  step: 'drawing' | 'photo' | 'done' | 'failed';
  ink?: SubmittedInk;
  job?: string;
  ref?: string;
  mockupJob?: string;
  /** False when the product photo could not be made: the drawing is shown instead. */
  photo?: boolean;
  error?: string;
}

export interface Finished {
  pending: Pending;
  /** The pictures as data URLs, when made on this page. */
  photo?: string;
  sketch?: string;
}

interface Hooks {
  token: string;
  onStage: (stage: Stage) => void;
  /** Called after every step with the state to keep. */
  save: (pending: Pending) => void;
  cancelled: () => boolean;
}

/** Makes the design, or carries on from where it was left. Null if cancelled. */
export async function runDesign(start: Pending, file: File | null, hooks: Hooks): Promise<Finished | null> {
  let pending = start;
  const save = (next: Partial<Pending>) => {
    pending = { ...pending, ...next };
    hooks.save(pending);
  };

  let sketch: string | undefined;
  if (pending.step === 'drawing') {
    if (!pending.ink) hooks.onStage('uploading');
    const drawn = await runSketch({
      file,
      category: pending.product.category,
      onStage: hooks.onStage,
      cancelled: hooks.cancelled,
      resume: pending.ink,
      onSubmitted: (ink) => save({ ink }),
    });
    if (!drawn || hooks.cancelled()) return null;
    sketch = drawn.image;
    save({ step: 'photo', job: drawn.job, ref: designRef(drawn.folder) });
  }

  hooks.onStage('photo');
  let photo: string | undefined;
  try {
    let design: Record<string, unknown> = { material: pending.metal };
    if (!pending.mockupJob) {
      sketch ??= await sketchOf(String(pending.job), hooks.token);
      const product = pending.product;
      // The pendant as the shop sells it: its cut outline traced from the drawing, in the chosen metal.
      const needsOutline = product.designType === 'edge-cut' || Boolean(PENDANT_SHAPES[product.shape].frame);
      const contour = needsOutline ? await extractSilhouetteContour(sketch, { sealEdges: product.category !== 'face' }) : null;
      design = {
        sketch,
        shape: product.shape,
        material: pending.metal,
        transform: DEFAULT_TRANSFORM,
        engravingArea: PENDANT_CATEGORIES[product.category].engravingArea,
        designType: product.designType,
        contour,
        rimColor: 'none',
        category: product.category,
      };
    }
    photo = await runMockup(design, { job: pending.mockupJob, onSubmitted: (mockupJob) => save({ mockupJob }) });
  } catch {
    photo = undefined;
  }
  if (hooks.cancelled()) return null;
  save({ step: 'done', photo: Boolean(photo) });
  return { pending, photo, sketch };
}

/** A design's saved drawing, as a data URL. Asked a few times: it is saved just after it is drawn. */
async function sketchOf(job: string, token: string): Promise<string> {
  const url = `/api/try/image?job=${encodeURIComponent(job)}&kind=sketch&token=${encodeURIComponent(token)}`;
  for (let i = 0; i < 6; i++) {
    const response = await fetch(url).catch(() => null);
    if (response?.ok) {
      const blob = await response.blob();
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error('The drawing could not be read back.');
}

// The photo, kept until the design is done. IndexedDB, because a File will
// not go into localStorage; any failure just means it is not kept.

function photos(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('true-tribute', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('photos');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withPhotos<T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest): Promise<T | null> {
  try {
    const db = await photos();
    return await new Promise<T | null>((resolve) => {
      const request = act(db.transaction('photos', mode).objectStore('photos'));
      request.onsuccess = () => resolve((request.result as T) ?? null);
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export const keepPhoto = (id: string, file: File) => withPhotos('readwrite', (s) => s.put(file, id));
export const takePhoto = (id: string) => withPhotos<File>('readonly', (s) => s.get(id));
export const dropPhoto = (id: string) => withPhotos('readwrite', (s) => s.delete(id));
