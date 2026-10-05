/**
 * Every picture the app makes, kept in the cloud (Vercel Blob, a PRIVATE
 * store: these are customers' family photos, and nothing here is reachable
 * by a public link).
 *
 * One folder per order, by day and by sketch:
 *
 *   orders/2026-10-05/ab12cd34ef/1432-photo.jpg              the customer's photo
 *                                1432-sketch.png             the drawing
 *                                1436-product-gold.png       each product photo
 *                                production-files.zip        SVG, DXF, 3DM, PNG (the latest)
 *
 * The folder is named from the sketch itself (a short hash of it), so the
 * three routes that save — sketch, product photo, production files — land in
 * the same place without anything having to be passed between them or kept
 * in the browser. Times are Indian time, where the shop is.
 *
 * Saving never gets in the way of the work: with no store connected it does
 * nothing, and if a save fails it is logged and the customer still gets
 * their picture.
 */

import { createHash } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';
import { put } from '@vercel/blob';

if (typeof window !== 'undefined') {
  throw new Error('lib/archive.ts was imported into a browser bundle. This module is server-only.');
}

const SHOP_TIME_ZONE = 'Asia/Kolkata';

function shopTime(now: Date): { day: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: SHOP_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}${parts.minute}` };
}

/** The bytes of a `data:` URL, or of a buffer as it is. */
function bytesOf(source: string | Uint8Array): Buffer {
  return typeof source === 'string' ? Buffer.from(source.slice(source.indexOf(',') + 1), 'base64') : Buffer.from(source);
}

/** The folder an order's files go in, from its sketch (a data URL, or the PNG itself). */
export function orderFolder(sketch: string | Uint8Array, now: Date = new Date()): string {
  const id = createHash('sha256').update(bytesOf(sketch)).digest('hex').slice(0, 10);
  return `orders/${shopTime(now).day}/${id}`;
}

/** A folder name this module made, and nothing else: it comes back to us through a batch job's metadata. */
export function isOrderFolder(value: unknown): value is string {
  return typeof value === 'string' && /^orders\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{10}$/.test(value);
}

/**
 * Saves one file into an order's folder. Never throws.
 *
 * Normally under the time it was made, so every product photo is kept. With
 * `latestOnly` the name is fixed and a newer file replaces the older one:
 * the production files are 12 MB a set, and an operator who adjusts a design
 * and exports it five times should not fill the store with five of them.
 */
export async function archive(
  folder: string,
  name: string,
  body: string | Uint8Array,
  contentType: string,
  { latestOnly = false } = {},
): Promise<void> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  const path = latestOnly ? `${folder}/${name}` : `${folder}/${shopTime(new Date()).time}-${name}`;
  try {
    await put(path, bytesOf(body), { access: 'private', contentType, addRandomSuffix: false, allowOverwrite: true });
    console.info(`[archive] saved ${path}`);
  } catch (error) {
    console.error(`[archive] could not save ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * A .zip of `files`. The production files are large as they stand — a DXF and
 * a 3DM of one pendant run to 25 MB between them — and compress to a
 * fraction of that; one zip per export also keeps the set together.
 */
export function zip(files: { name: string; data: Uint8Array }[]): Buffer {
  // The time on every entry, in the zip format's own packing (local time, two-second steps).
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: SHOP_TIME_ZONE }));
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const raw = Buffer.from(file.data);
    const packed = deflateRawSync(raw, { level: 6 });
    const sum = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(dosTime, 12);
    entry.writeUInt16LE(dosDate, 14);
    entry.writeUInt32LE(sum, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    parts.push(local, name, packed);
    directory.push(entry, name);
    offset += local.length + name.length + packed.length;
  }
  const directorySize = directory.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...directory, end]);
}
