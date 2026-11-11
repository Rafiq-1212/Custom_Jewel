/**
 * POST { sketch, material, image } — keeps the gold/silver picture painted in
 * the browser (lib/mockup-client.ts, 'preview' mode) as the design's product
 * photo: saved in its order folder and counted like one, so the admin panel,
 * the shop's cart and /api/try/image find it exactly where an AI product
 * photo would be. No AI call, so it costs nothing.
 */

import { archive, orderFolder } from '@/lib/archive';
import { customerFolderJob, photosOf } from '@/lib/customers';
import { isMaterialId } from '@/lib/materials';
import { callerOf } from '@/lib/signed-in';
import { trackEvent } from '@/lib/tracking';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Pictures a shop customer may keep from one design, as for the AI photos (/api/render-mockup). */
const CUSTOMER_PHOTOS = 3;
const IMAGE = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

function fail(message: string, status: number): Response {
  return Response.json({ success: false, error: message }, { status });
}

export async function POST(request: Request): Promise<Response> {
  const caller = await callerOf(request);
  if (caller instanceof Response) return caller;
  const body = (await request.json().catch(() => null)) as { sketch?: unknown; material?: unknown; image?: unknown } | null;
  const sketch = typeof body?.sketch === 'string' && body.sketch.startsWith('data:image/') ? body.sketch : null;
  const material = typeof body?.material === 'string' && isMaterialId(body.material) ? body.material : null;
  const image = typeof body?.image === 'string' ? IMAGE.exec(body.image) : null;
  if (!sketch || !material || !image) return fail('Something went wrong. Please try again.', 400);
  const bytes = Buffer.from(image[2], 'base64');
  if (bytes.length > MAX_IMAGE_BYTES) return fail('That picture is too large.', 413);

  const folder = orderFolder(sketch);
  if (caller.kind === 'customer') {
    if (!(await customerFolderJob(caller.phone, folder))) return fail('Make your design first, then the photo.', 403);
    if ((await photosOf(folder)) >= CUSTOMER_PHOTOS) return fail('You have all the photos of this design already.', 429);
  }

  const type = image[1] === 'png' ? 'png' : 'jpg';
  const file = await archive(folder, `product-${material}.${type}`, bytes, `image/${image[1]}`);
  await trackEvent({
    kind: 'product_photo',
    folder,
    detail: material,
    costUsd: 0,
    file,
    userId: caller.kind === 'staff' ? caller.staff.id : null,
    phone: caller.kind === 'customer' ? caller.phone : null,
  });
  return Response.json({ success: true, file });
}
