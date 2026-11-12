/**
 * POST { ...design, save? } — the design's final gold/silver picture
 * ('preview' mode, lib/mockup-client.ts), drawn here (lib/final-picture.ts)
 * so it comes out the same on every phone. Returns it as a data URL.
 *
 * Saved by default: kept in the order folder and counted like a product
 * photo, so the admin panel, the shop's cart and /api/try/image find it
 * exactly where an AI product photo would be. `save: false` only draws it.
 * No AI call, so it costs nothing.
 *
 * A customer's picture is saved once per request, as their photos are
 * counted. The team's tool saves on every change (components/MockupPanel.tsx),
 * so for the team there is one file per design and metal, replaced each
 * time, and one line in the ledger for it.
 *
 * The body is the design, as for /api/render-mockup (lib/design-request.ts).
 */

import { archive, orderFolder } from '@/lib/archive';
import { customerFolderJob, photoRecorded, photosOf } from '@/lib/customers';
import { parseDesignRequest } from '@/lib/design-request';
import { renderFinalPicture } from '@/lib/final-picture';
import { callerOf } from '@/lib/signed-in';
import { trackEvent } from '@/lib/tracking';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Pictures a shop customer may keep from one design, as for the AI photos (/api/render-mockup). */
const CUSTOMER_PHOTOS = 3;

function fail(message: string, status: number): Response {
  return Response.json({ success: false, error: message }, { status });
}

export async function POST(request: Request): Promise<Response> {
  const caller = await callerOf(request);
  if (caller instanceof Response) return caller;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const parsed = parseDesignRequest(body);
  if (!parsed.ok) return fail(parsed.error, 400);
  const design = parsed.value;
  // Only the team's live tiles skip the save; a customer's picture is always kept.
  const save = caller.kind === 'customer' || body?.save !== false;

  const folder = orderFolder(design.sketch);
  if (caller.kind === 'customer') {
    if (!(await customerFolderJob(caller.phone, folder))) return fail('Make your design first, then the photo.', 403);
    if ((await photosOf(folder)) >= CUSTOMER_PHOTOS) return fail('You have all the photos of this design already.', 429);
  }

  let picture: Buffer;
  try {
    picture = await renderFinalPicture(design);
  } catch (error) {
    console.error('[product-preview]', error instanceof Error ? error.message : error);
    return fail('We couldn\'t make the picture. Please try again.', 500);
  }

  let file: string | null = null;
  if (save) {
    const staff = caller.kind === 'staff';
    file = await archive(folder, `product-${design.material}.jpg`, picture, 'image/jpeg', { latestOnly: staff });
    if (file && staff && (await photoRecorded(file))) {
      return Response.json({ success: true, file, dataUrl: `data:image/jpeg;base64,${picture.toString('base64')}` });
    }
    await trackEvent({
      kind: 'product_photo',
      folder,
      detail: design.material,
      costUsd: 0,
      file,
      userId: caller.kind === 'staff' ? caller.staff.id : null,
      phone: caller.kind === 'customer' ? caller.phone : null,
    });
  }
  return Response.json({ success: true, file, dataUrl: `data:image/jpeg;base64,${picture.toString('base64')}` });
}
