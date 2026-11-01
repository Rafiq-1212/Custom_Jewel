/**
 * The record of what was made and what it cost (db/schema.sql), written here
 * and read by the admin app (admin/).
 *
 * Every step that spends money leaves a row: a sketch started, a sketch
 * finished or failed, a product photo, a set of production files. That is
 * what answers "how many did we try, how many came out, what did it cost".
 *
 * Recording never gets in the way of the work: with no database connected it
 * does nothing, and a failed write is logged and forgotten.
 */

import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

if (typeof window !== 'undefined') {
  throw new Error('lib/tracking.ts was imported into a browser bundle. This module is server-only.');
}

// Made on first use, not at import: `next build` loads this module with no
// database in the environment.
let client: NeonQueryFunction<false, false> | null = null;
function db(): NeonQueryFunction<false, false> | null {
  if (!process.env.DATABASE_URL) return null;
  client ??= neon(process.env.DATABASE_URL);
  return client;
}

async function write(what: string, run: (sql: NeonQueryFunction<false, false>) => Promise<unknown>): Promise<void> {
  const sql = db();
  if (!sql) return;
  try {
    await run(sql);
  } catch (error) {
    console.error(`[tracking] could not record ${what}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export type EventKind = 'sketch_start' | 'sketch_done' | 'sketch_redo' | 'sketch_failed' | 'product_photo' | 'production_files' | 'otp_sent';

export interface TrackedEvent {
  kind: EventKind;
  costUsd: number;
  /** The drawing job, for the sketch steps. */
  generationId?: string;
  /** The order's folder in the image store, when the sketch exists. */
  folder?: string;
  /** Category, metal, or the error. */
  detail?: string;
  /** Where the result was saved, if it was. */
  file?: string | null;
  /** The team member who did it (their admin login's id). */
  userId?: string | null;
  /** Or the shop customer it was for. */
  phone?: string | null;
}

/** One line in the ledger. */
export function trackEvent(event: TrackedEvent): Promise<void> {
  return write(event.kind, (sql) =>
    sql`insert into events (kind, generation_id, folder, detail, cost_usd, file, user_id, phone)
        values (${event.kind}, ${event.generationId ?? null}, ${event.folder ?? null}, ${event.detail ?? null}, ${event.costUsd}, ${event.file ?? null}, ${event.userId ?? null}, ${event.phone ?? null})`,
  );
}

/** Who something was made for: a team member (their admin login), or a shop customer (their phone). */
export interface Who {
  userId: string | null;
  phone: string | null;
}

/** A photo went in and its drawing was queued. */
export async function trackSketchStarted(
  generationId: string,
  category: string,
  costUsd: number,
  who: Who,
  /** For a redraw: the drawing it corrects, and the corrections it was given. */
  redraw?: { parent: string; corrections: string },
  /** Where the photo was saved as uploaded (app/api/sketch, action=start). */
  upload: string | null = null,
): Promise<void> {
  await write('a sketch start', (sql) =>
    sql`insert into generations (id, category, created_by, phone, parent_id, corrections)
        values (${generationId}, ${category}, ${who.userId}, ${who.phone}, ${redraw?.parent ?? null}, ${redraw?.corrections || null})
        on conflict (id) do nothing`,
  );
  await trackEvent({ kind: 'sketch_start', generationId, detail: category, costUsd, file: upload, ...who });
}

/**
 * Which design folder a drawing is, recorded at once when it comes back:
 * the customer's product photo is asked for a second later, before the
 * files are saved and trackSketchDone runs.
 */
export async function trackSketchFolder(generationId: string, folder: string): Promise<void> {
  await write('a sketch folder', (sql) => sql`update generations set folder = ${folder} where id = ${generationId}`);
}

/** The drawing came back and was saved. */
export async function trackSketchDone(generationId: string, folder: string, costUsd: number, file: string | null, who: Who): Promise<void> {
  await write('a finished sketch', (sql) =>
    sql`update generations set status = 'done', finished_at = now(), folder = ${folder}, error = null where id = ${generationId}`,
  );
  await trackEvent({ kind: 'sketch_done', generationId, folder, costUsd, file, ...who });
}

/** The drawing could not be made. */
export async function trackSketchFailed(generationId: string | undefined, reason: string, costUsd: number, who: Who): Promise<void> {
  if (generationId) {
    await write('a failed sketch', (sql) =>
      sql`update generations set status = 'failed', finished_at = now(), error = ${reason} where id = ${generationId} and status <> 'done'`,
    );
  }
  await trackEvent({ kind: 'sketch_failed', generationId, detail: reason, costUsd, ...who });
}
