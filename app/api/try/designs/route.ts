/** GET /api/try/designs — the signed-in shop customer's finished designs, newest first. */

import { customerOf } from '@/lib/customer-session';
import { designsOf } from '@/lib/customers';
import { designRef } from '@/lib/design-ref';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const phone = customerOf(request);
  if (!phone) return Response.json({ success: false, error: 'Please sign in with your mobile number again.', signIn: true }, { status: 401 });
  const designs = await designsOf(phone);
  return Response.json({ success: true, designs: designs.map((d) => ({ job: d.job, createdAt: d.createdAt, category: d.category, ref: designRef(d.folder) })) });
}
