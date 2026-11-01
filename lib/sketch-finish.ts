/**
 * A finished drawing collected by the server, for someone who left before
 * their own page collected it.
 *
 * A drawing is read back by the page that started it (app/api/sketch,
 * action=collect). A customer who closed the window or left the shop while
 * it was drawn never came back for it: on 31 Oct two customers' drawings had
 * finished at Google and were never saved, so they showed in the admin panel
 * as "abandoned while drawing", and each customer had lost a design. Now the
 * server collects it: in the background just after it starts
 * (`collectWhenLeft`), and when the customer next opens the window
 * (`collectLeftDrawings`). They find it under "Your designs".
 */

import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { archive, orderFolder } from './archive';
import { costSoFar, withCostLog } from './cost';
import { readJobState } from './gemini-batch';
import { makeTransparentMasterSketch } from './image-processing';
import { loadInkInputs } from './ink-inputs';
import { isCategoryId } from './pendant-categories';
import { refundTry } from './customers';
import { collectInked } from './sketch-pipeline';
import { trackSketchDone, trackSketchFailed, trackSketchFolder, type Who } from './tracking';

if (typeof window !== 'undefined') {
  throw new Error('lib/sketch-finish.ts was imported into a browser bundle. This module is server-only.');
}

let client: NeonQueryFunction<false, false> | null = null;
function db(): NeonQueryFunction<false, false> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
  client ??= neon(process.env.DATABASE_URL);
  return client;
}

/** How long a finished drawing is left for its own page to collect (it asks every few seconds) before the server does. */
const PAGE_GRACE_MS = 60_000;
/** How often the background wait asks whether the drawing is finished. */
const POLL_MS = 10_000;

/**
 * Collects one drawing if it is finished and still nobody has: saves it to
 * its folder and marks it done, or marks it failed and gives a customer their
 * design back. Does nothing to one already collected or still being drawn.
 */
export async function collectLeftDrawing(job: string): Promise<'done' | 'failed' | 'waiting' | 'skipped'> {
  const [row] = await db()`select status, phone, created_by, category from generations where id = ${job}`;
  if (!row || row.status !== 'running' || !isCategoryId(row.category)) return 'skipped';
  const state = await readJobState(job);
  if (state === 'running') return 'waiting';
  const who: Who = { userId: row.created_by ?? null, phone: row.phone ?? null };
  return withCostLog(`inking ${row.category} (collected for someone who left)`, async () => {
    try {
      if (state === 'failed') throw new Error('The drawing job failed at Google.');
      const inked = await collectInked(job, row.category);
      const master = await makeTransparentMasterSketch(inked);
      const folder = orderFolder(master.buffer);
      await trackSketchFolder(job, folder);
      // The photo it was drawn from: the edited one kept for redraws, as the upload went with the page.
      const kept = await loadInkInputs(job).catch(() => null);
      const [, saved] = await Promise.all([
        kept ? archive(folder, 'photo.png', kept.photo, 'image/png') : null,
        archive(folder, 'sketch.png', master.buffer, 'image/png'),
      ]);
      await trackSketchDone(job, folder, costSoFar(), saved, who);
      console.info(`[sketch finish] ${job}: collected for someone who left, saved in ${folder}`);
      return 'done';
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[sketch finish] ${job}: could not collect it: ${reason}`);
      // A customer's own design is given back; one the team made for them (a remake) never cost them one.
      if (who.phone && !who.userId) await refundTry(who.phone);
      await trackSketchFailed(job, reason.slice(0, 500), costSoFar(), who);
      return 'failed';
    }
  });
}

/**
 * Run in the background of the request that started a drawing: waits for it
 * to finish, gives its own page a minute to collect it, then collects it if
 * the page did not. Stops at `deadline` (the request's time limit); a drawing
 * still unfinished then is collected when its customer comes back.
 */
export async function collectWhenLeft(job: string, deadline: number, grace = PAGE_GRACE_MS): Promise<void> {
  try {
    while (Date.now() + POLL_MS < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      if ((await readJobState(job)) === 'running') continue;
      if (Date.now() + grace + 20_000 > deadline) return;
      await new Promise((resolve) => setTimeout(resolve, grace));
      await collectLeftDrawing(job);
      return;
    }
  } catch (error) {
    console.error(`[sketch finish] ${job}: background wait stopped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A customer's drawings that finished while they were away, collected before their designs are listed. */
export async function collectLeftDrawings(phone: string): Promise<void> {
  const rows = await db()`
    select id from generations
    where phone = ${phone} and status = 'running' and created_at < now() - interval '3 minutes' and created_at > now() - interval '14 days'
    order by created_at limit 3`;
  for (const row of rows) await collectLeftDrawing(row.id).catch(() => undefined);
}

/** What a design was made from, for making it again: the photo as uploaded, its style, and the customer it was for. */
export async function uploadOf(job: string): Promise<{ upload: string; category: string; phone: string | null } | null> {
  const [row] = await db()`
    select e.file, g.category, g.phone from generations g
    join events e on e.generation_id = g.id and e.kind = 'sketch_start' and e.file is not null
    where g.id = ${job} order by e.id limit 1`;
  return row ? { upload: row.file, category: row.category, phone: row.phone ?? null } : null;
}
