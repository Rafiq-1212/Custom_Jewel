/**
 * GET /api/try/me — who the shop customer is signed in as, how many designs
 * they have left, and the support number to call when they have none.
 * A sign-in over a day old comes back renewed, so the 30 days run from the
 * customer's last visit, not their first.
 */

import { customerOf, renewedToken } from '@/lib/customer-session';
import { allowanceOf, setting } from '@/lib/customers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const phone = customerOf(request);
  const supportPhone = await setting('support_phone').catch(() => '');
  if (!phone) return Response.json({ success: true, signedIn: false, supportPhone });
  const allowance = await allowanceOf(phone);
  if (!allowance) return Response.json({ success: true, signedIn: false, supportPhone });
  return Response.json({ success: true, signedIn: true, phone, ...allowance, supportPhone, token: renewedToken(request) });
}
