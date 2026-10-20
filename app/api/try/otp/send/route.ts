/**
 * POST /api/try/otp/send — a shop customer asks for a sign-in code.
 *   { phone } -> { resendAfter }
 * Limited per phone and per device (lib/customers.ts); the code goes out by
 * SMS through 2Factor (lib/otp.ts) and is never sent back.
 */

import { codeLimit, storeCode } from '@/lib/customers';
import { generateCode, normalisePhone, OTP_COST_USD, RESEND_SECONDS, sendCode, SmsError } from '@/lib/otp';
import { trackEvent } from '@/lib/tracking';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function fail(message: string, status: number): Response {
  return Response.json({ success: false, error: message }, { status });
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { phone?: unknown } | null;
  const phone = normalisePhone(body?.phone);
  if (!phone) return fail('Please enter a 10-digit Indian mobile number.', 400);
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || null;
  try {
    const limited = await codeLimit(phone, ip);
    if (limited) return fail(limited, 429);
    const code = generateCode();
    await storeCode(phone, code, ip);
    const via = await sendCode(phone, code);
    await trackEvent({ kind: 'otp_sent', detail: via, costUsd: via === '2factor' ? OTP_COST_USD : 0, phone });
    return Response.json({ success: true, resendAfter: RESEND_SECONDS });
  } catch (error) {
    if (error instanceof SmsError) return fail(error.message, 502);
    console.error(`[otp send] ${error instanceof Error ? error.message : String(error)}`);
    return fail('Something went wrong. Please try again.', 500);
  }
}
