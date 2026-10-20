/**
 * Sign-in codes for shop customers, sent by SMS through 2Factor.
 *
 * We make the 6-digit code and check it ourselves; 2Factor only delivers it,
 * in the DLT-approved template (TWOFACTOR_TEMPLATE, as named in the 2Factor
 * dashboard). Codes last OTP_MINUTES, are stored only as a keyed hash
 * (lib/customer-session.ts), and die after MAX_ATTEMPTS wrong guesses.
 *
 * With no TWOFACTOR_API_KEY, development prints the code to the server log
 * instead of sending it; production refuses, rather than let anyone sign in.
 */

import { randomInt } from 'node:crypto';

if (typeof window !== 'undefined') {
  throw new Error('lib/otp.ts was imported into a browser bundle. This module is server-only.');
}

/** The words a customer agrees to when they tick the box on the sign-in screen; kept with their record. */
export const CONSENT_TEXT = 'Send me offers and updates from True Tribute by SMS and WhatsApp.';

export const OTP_MINUTES = 5;
export const MAX_ATTEMPTS = 5;
export const RESEND_SECONDS = 30;
/** Most codes sent, per phone per hour and per day, and per device (IP) per hour. */
export const LIMITS = { phoneHour: 3, phoneDay: 6, ipHour: 10 };
/** What one SMS costs us, in dollars, for the ledger (₹0.15 + GST). */
export const OTP_COST_USD = Number(process.env.OTP_COST_USD) || 0.0019;

/** A 10-digit Indian mobile, with or without +91, 91 or 0 in front, as +91XXXXXXXXXX; anything else is null. */
export function normalisePhone(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let digits = input.replace(/[^\d]/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
}

export function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export class SmsError extends Error {}

/** Sends the code. Throws SmsError with a sentence for the customer if it could not be sent. */
export async function sendCode(phone: string, code: string): Promise<'2factor' | 'console'> {
  const key = process.env.TWOFACTOR_API_KEY;
  if (!key) {
    if (process.env.NODE_ENV === 'production') throw new SmsError('Text messages are not set up yet. Please try again later.');
    console.info(`[otp] (no TWOFACTOR_API_KEY: not sent) code for ${phone}: ${code}`);
    return 'console';
  }
  const template = process.env.TWOFACTOR_TEMPLATE ? `/${encodeURIComponent(process.env.TWOFACTOR_TEMPLATE)}` : '';
  const url = `https://2factor.in/API/V1/${encodeURIComponent(key)}/SMS/${encodeURIComponent(phone.replace('+', ''))}/${code}${template}`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const body = (await response.json().catch(() => null)) as { Status?: string; Details?: string } | null;
    if (!response.ok || body?.Status !== 'Success') {
      console.error(`[otp] 2Factor refused: ${response.status} ${body?.Details ?? ''}`);
      throw new SmsError('We couldn\'t send the code. Please check the number and try again.');
    }
    return '2factor';
  } catch (error) {
    if (error instanceof SmsError) throw error;
    console.error(`[otp] 2Factor unreachable: ${error instanceof Error ? error.message : String(error)}`);
    throw new SmsError('We couldn\'t send the code just now. Please try again in a minute.');
  }
}
