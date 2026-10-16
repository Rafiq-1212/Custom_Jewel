/**
 * GET /api/feedback-export?issue=...&stage=... — every report of one problem,
 * as one zip: for each, the customer's photo, the sketch and a note with what
 * was said, by whom and when. For whoever is fixing that problem in the tool.
 * A signed-in login with the Feedback screen only.
 */

import { get, list } from '@vercel/blob';
import { headers } from 'next/headers';
import { canSee, toRole, toScreens } from '@/lib/access';
import { auth } from '@/lib/auth';
import { PERSON_LABELS, STAGE_LABELS } from '@/lib/feedback-labels';
import { when } from '@/lib/format';
import { db } from '@/lib/db';
import { feedbackList } from '@/lib/queries';
import { zip } from '@/lib/zip';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** At most this many reports go in one download. */
const MOST = 40;

async function bytes(path: string): Promise<Uint8Array | null> {
  const file = await get(path, { access: 'private' }).catch(() => null);
  if (!file || file.statusCode !== 200) return null;
  return new Uint8Array(await new Response(file.stream).arrayBuffer());
}

export async function GET(request: Request): Promise<Response> {
  const session = await auth().api.getSession({ headers: await headers() });
  if (!session) return new Response('Sign in first.', { status: 401 });
  const user = session.user as typeof session.user & { role?: unknown; screens?: unknown; mustChangePassword?: unknown };
  if (user.mustChangePassword === true || !canSee({ role: toRole(user.role), screens: toScreens(user.screens) }, 'feedback')) {
    return new Response('Not allowed.', { status: 403 });
  }

  const params = new URL(request.url).searchParams;
  const issue = params.get('issue');
  const stage = params.get('stage');
  if (!issue || !stage || !STAGE_LABELS[stage]) return new Response('Not found', { status: 404 });

  const items = (await feedbackList({ issue, stage, rating: 'bad' }, MOST)).filter((f) => f.generationId);
  const folders = await db()`select id, folder from generations where id = any(${items.map((f) => f.generationId)})`;
  const folderOf = new Map(folders.map((r) => [r.id as string, r.folder as string | null]));

  const files: { name: string; data: Uint8Array }[] = [];
  for (const [n, f] of items.entries()) {
    const dir = `${String(n + 1).padStart(2, '0')}-${f.createdAt ? new Date(f.createdAt).toISOString().slice(0, 10) : 'undated'}-${f.category ?? 'design'}`;
    const lines = [
      `${STAGE_LABELS[f.stage]} — ${f.rating === 'bad' ? 'needs changes' : 'looks right'}`,
      `Given by ${f.by ?? 'unknown'} on ${when(f.createdAt)}`,
      `Problems: ${f.issueLabels.join('; ') || 'none ticked'}`,
      f.person && f.person !== 'all' ? `About: ${PERSON_LABELS[f.person] ?? f.person}` : '',
      f.note ? `Note: ${f.note}` : '',
      `Status: ${f.status}${f.resolution ? ` — ${f.resolution}` : ''}`,
      `Design: ${f.generationId}`,
    ].filter(Boolean);
    files.push({ name: `${dir}/feedback.txt`, data: Buffer.from(lines.join('\n') + '\n', 'utf8') });
    const folder = folderOf.get(f.generationId as string);
    if (!folder) continue;
    const saved = await list({ prefix: `${folder}/` }).catch(() => ({ blobs: [] }));
    for (const blob of saved.blobs) {
      const name = blob.pathname.slice(blob.pathname.lastIndexOf('/') + 1);
      if (!/(photo|sketch)\.(png|jpe?g|webp)$/.test(name)) continue;
      const data = await bytes(blob.pathname);
      if (data) files.push({ name: `${dir}/${name}`, data });
    }
  }

  return new Response(new Uint8Array(zip(files)), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="feedback-${stage}-${issue}.zip"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
