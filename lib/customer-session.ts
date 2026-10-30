/**
 * A shop customer's sign-in: a token naming their phone, signed with
 * SESSION_SECRET and good for 30 days. Sent by the customer page as
 * `Authorization: Bearer <token>`, not a cookie: the page lives in a frame
 * on the shop's site, where Safari drops third-party cookies.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

if (typeof window !== 'undefined') {
  throw new Error('lib/customer-session.ts was imported into a browser bundle. This module is server-only.');
}

export const SESSION_DAYS = 30;

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) throw new Error('SESSION_SECRET is not set (32 characters or more).');
  return value;
}

function sign(body: string): string {
  return createHmac('sha256', secret()).update(body).digest('base64url');
}

/** A token for this phone. */
export function issueToken(phone: string): string {
  const body = Buffer.from(JSON.stringify({ sub: phone, exp: Date.now() + SESSION_DAYS * 86_400_000 })).toString('base64url');
  return `${body}.${sign(body)}`;
}

function payloadOf(token: string | null | undefined): { sub: string; exp: number } | null {
  if (!token) return null;
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { sub?: unknown; exp?: unknown };
    if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return { sub: payload.sub, exp: payload.exp };
  } catch {
    return null;
  }
}

/** The phone a token was issued to, if it is genuine and not expired. */
export function phoneFromToken(token: string | null | undefined): string | null {
  return payloadOf(token)?.sub ?? null;
}

function bearerOf(request: Request): string | null {
  const header = request.headers.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

/** The signed-in customer's phone, from a request's Authorization header. */
export function customerOf(request: Request): string | null {
  return phoneFromToken(bearerOf(request));
}

/** A new token when the request's is over a day old: a customer who keeps coming back is never asked for a code again. */
export function renewedToken(request: Request): string | undefined {
  const payload = payloadOf(bearerOf(request));
  return payload && payload.exp - Date.now() < (SESSION_DAYS - 1) * 86_400_000 ? issueToken(payload.sub) : undefined;
}

/** The key in a design's picture link on the shop's cart line: shows that design's pictures, nothing else, to whoever has the cart. */
export function pictureKey(job: string): string {
  return createHmac('sha256', secret()).update(`picture:${job}`).digest('base64url').slice(0, 32);
}

/** A keyed hash, for sign-in codes: never stored as they are. */
export function keyedHash(value: string): string {
  return createHmac('sha256', secret()).update(`otp:${value}`).digest('hex');
}
