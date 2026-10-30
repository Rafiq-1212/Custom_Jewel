/**
 * GET /api/try/picture-key?job=... — for the signed-in customer's own design,
 * the key that goes in its picture link on their shop cart line
 * (/api/try/image?...&key=), so the cart can show it without their sign-in.
 */

import { customerOf, pictureKey } from '@/lib/customer-session';
import { folderOf } from '@/lib/customers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const phone = customerOf(request);
  if (!phone) return Response.json({ success: false, error: 'Sign in first.' }, { status: 401 });
  const job = new URL(request.url).searchParams.get('job') ?? '';
  if (!(await folderOf(phone, job))) return Response.json({ success: false, error: 'Not found' }, { status: 404 });
  return Response.json({ success: true, key: pictureKey(job) });
}
