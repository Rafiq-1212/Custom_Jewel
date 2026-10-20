/**
 * POST /api/try/otp/verify — a shop customer types the code they were sent.
 *   { phone, code, consent?, source? } -> { token, phone, left, limit }
 * The token (lib/customer-session.ts) keeps them signed in for 30 days.
 */

import { issueToken } from '@/lib/customer-session';
import { allowanceOf, checkCode, signInCustomer } from '@/lib/customers';
import { CONSENT_TEXT, normalisePhone } from '@/lib/otp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function fail(message: string, status: number): Response {
  return Response.json({ success: false, error: message }, { status });
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { phone?: unknown; code?: unknown; consent?: unknown; source?: unknown } | null;
  const phone = normalisePhone(body?.phone);
  const code = typeof body?.code === 'string' ? body.code.replace(/\D/g, '') : '';
  if (!phone) return fail('Please enter a 10-digit Indian mobile number.', 400);
  if (code.length !== 6) return fail('Enter the 6-digit code from the text message.', 400);
  try {
    const result = await checkCode(phone, code);
    if (result === 'expired') return fail('That code has expired. Please ask for a new one.', 400);
    if (result === 'wrong') return fail('That code isn\'t right. Please check the text message and try again.', 400);
    const source = typeof body?.source === 'string' ? body.source.slice(0, 120) : null;
    await signInCustomer(phone, source, body?.consent === true ? CONSENT_TEXT : null);
    const allowance = await allowanceOf(phone);
    return Response.json({ success: true, token: issueToken(phone), phone, left: allowance?.left ?? 0, limit: allowance?.limit ?? 0 });
  } catch (error) {
    console.error(`[otp verify] ${error instanceof Error ? error.message : String(error)}`);
    return fail('Something went wrong. Please try again.', 500);
  }
}
