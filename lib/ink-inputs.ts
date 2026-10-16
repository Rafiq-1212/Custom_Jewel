/**
 * The drawing step's inputs, kept per sketch so it can be asked again with
 * the shop's corrections (lib/feedback.ts): a redraw then costs the drawing
 * alone (about ₹5) and not the photo edit as well.
 *
 * In the private image store (lib/archive.ts), beside the orders and apart
 * from them: drafts/<job id>/trace.png, photo.png and inputs.json. Saving
 * never gets in the way: a failed save only means that sketch cannot be
 * redrawn, and the operator is told so if they ask.
 */

import { get, put } from '@vercel/blob';
import { isCategoryId } from './pendant-categories';
import type { InkInputs } from './sketch-pipeline';

if (typeof window !== 'undefined') {
  throw new Error('lib/ink-inputs.ts was imported into a browser bundle. This module is server-only.');
}

/** A batch job's name, as the API returns it: batches/<id>. */
const JOB_NAME = /^batches\/([A-Za-z0-9_-]{1,128})$/;

function folderOf(job: string): string | null {
  const id = JOB_NAME.exec(job)?.[1];
  return id ? `drafts/${id}` : null;
}

async function save(path: string, body: Buffer | string, contentType: string): Promise<void> {
  await put(path, body, { access: 'private', contentType, addRandomSuffix: false, allowOverwrite: true });
}

export async function saveInkInputs(job: string, inputs: InkInputs): Promise<void> {
  const folder = folderOf(job);
  if (!folder || !process.env.BLOB_READ_WRITE_TOKEN) return;
  try {
    const { trace, photo, ...rest } = inputs;
    await Promise.all([
      save(`${folder}/trace.png`, trace, 'image/png'),
      save(`${folder}/photo.png`, photo, 'image/png'),
      save(`${folder}/inputs.json`, JSON.stringify(rest), 'application/json'),
    ]);
  } catch (error) {
    console.error(`[ink-inputs] could not keep the inputs of ${job}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function read(path: string): Promise<Buffer | null> {
  const file = await get(path, { access: 'private' }).catch(() => null);
  if (!file || file.statusCode !== 200) return null;
  return Buffer.from(await new Response(file.stream).arrayBuffer());
}

/** The inputs a sketch was drawn from, or null if they were not kept (sketches made before redraws existed). */
export async function loadInkInputs(job: string): Promise<InkInputs | null> {
  const folder = folderOf(job);
  if (!folder || !process.env.BLOB_READ_WRITE_TOKEN) return null;
  const [trace, photo, json] = await Promise.all([read(`${folder}/trace.png`), read(`${folder}/photo.png`), read(`${folder}/inputs.json`)]);
  if (!trace || !photo || !json) return null;
  const rest = JSON.parse(json.toString('utf8')) as Partial<InkInputs>;
  if (typeof rest.category !== 'string' || !isCategoryId(rest.category)) return null;
  return {
    category: rest.category,
    trace,
    photo,
    facts: typeof rest.facts === 'string' ? rest.facts : '',
    corrections: typeof rest.corrections === 'string' ? rest.corrections : '',
    metadata: rest.metadata,
  };
}
