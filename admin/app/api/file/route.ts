/**
 * GET /api/file?path=orders/... — one saved file from the private image
 * store, for a signed-in admin only. The store has no public links, so every
 * picture the panel shows comes through here.
 *
 * `&w=` (one of WIDTHS) returns a picture scaled down to that width: the
 * Generations list showed 50 sketches at full size, some 15 MB for a column
 * of thumbnails. Without it the file comes back exactly as saved.
 */

import { get } from '@vercel/blob';
import sharp from 'sharp';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Only what the pendant tool saves: orders/<day>/<id>/<file>. */
const SAVED_FILE = /^orders\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{10}\/[A-Za-z0-9._-]{1,80}$/;
const WIDTHS = new Set([160, 480]);
const PICTURE = /\.(png|jpe?g|webp)$/;

export async function GET(request: Request): Promise<Response> {
  const session = await auth().api.getSession({ headers: await headers() });
  if (!session) return new Response('Sign in first.', { status: 401 });

  const params = new URL(request.url).searchParams;
  const path = params.get('path') ?? '';
  if (!SAVED_FILE.test(path)) return new Response('Not found', { status: 404 });
  const width = Number(params.get('w'));
  try {
    const file = await get(path, { access: 'private' });
    if (!file || file.statusCode !== 200) return new Response('Not found', { status: 404 });
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (WIDTHS.has(width) && PICTURE.test(name)) {
      const bytes = Buffer.from(await new Response(file.stream).arrayBuffer());
      // WebP keeps a sketch's transparent background.
      const small = await sharp(bytes).resize({ width, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
      return new Response(new Uint8Array(small), { headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=86400' } });
    }
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
