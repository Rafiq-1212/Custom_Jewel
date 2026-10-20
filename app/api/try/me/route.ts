/**
 * GET /api/try/me — who the shop customer is signed in as, how many designs
 * they have left, and the support number to call when they have none.
 */

import { customerOf } from '@/lib/customer-session';
import { allowanceOf, setting } from '@/lib/customers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const phone = customerOf(request);
  const supportPhone = await setting('support_phone').catch(() => '');
  if (!phone) return Response.json({ success: true, signedIn: false, supportPhone });
  const allowance = await allowanceOf(phone);
  if (!allowance) return Response.json({ success: true, signedIn: false, supportPhone });
  return Response.json({ success: true, signedIn: true, phone, ...allowance, supportPhone });
}
