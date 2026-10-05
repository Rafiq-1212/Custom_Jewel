/**
 * GET /api/file?path=orders/... — one saved file from the private image
 * store, for a signed-in admin only. The store has no public links, so every
 * picture the panel shows comes through here.
 */

import { get } from '@vercel/blob';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Only what the pendant tool saves: orders/<day>/<id>/<file>. */
const SAVED_FILE = /^orders\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{10}\/[A-Za-z0-9._-]{1,80}$/;

export async function GET(request: Request): Promise<Response> {
  const session = await auth().api.getSession({ headers: await headers() });
  if (!session) return new Response('Sign in first.', { status: 401 });

  const path = new URL(request.url).searchParams.get('path') ?? '';
  if (!SAVED_FILE.test(path)) return new Response('Not found', { status: 404 });
  try {
    const file = await get(path, { access: 'private' });
    if (!file || file.statusCode !== 200) return new Response('Not found', { status: 404 });
    const name = path.slice(path.lastIndexOf('/') + 1);
    return new Response(file.stream, {
      headers: {
        'Content-Type': file.blob.contentType,
        'Cache-Control': 'private, max-age=300',
        ...(name.endsWith('.zip') ? { 'Content-Disposition': `attachment; filename="${name}"` } : {}),
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
