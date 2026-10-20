/**
 * Who is using the tool. The whole tool is for the shop's team: its page and
 * every route that costs money or hands out customers' pictures are closed
 * to anyone not signed in to the admin panel, and to logins that may not
 * make pendants (viewers, and editors not given Create a pendant). The rule
 * is the panel's own (admin/lib/access.ts).
 *
 * The panel owns the sign-in (Better Auth, admin/lib/auth.ts). Its cookie is
 * set on this site, because the panel is served here at /admin, so the tool
 * passes the visitor's cookies to the panel and asks it. One short call per
 * request; a sketch takes minutes.
 *
 * Whoever is signed in is also who made what: their id goes on every design
 * and every step in the ledger (lib/tracking.ts).
 */

import { ADMIN_ORIGIN } from './admin-origin';
import { customerOf } from './customer-session';

export interface Staff {
  id: string;
  email: string;
  role: string;
  screens: string[];
  mustChangePassword: boolean;
}

/** Better Auth's session cookie, with or without the __Secure- prefix it gets over https. */
const SESSION_COOKIE = /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/;
const TIMEOUT_MS = 5000;

/** The signed-in login, or null. */
export async function staffFrom(cookies: string | null): Promise<Staff | null> {
  if (!cookies || !SESSION_COOKIE.test(cookies)) return null;
  try {
    const response = await fetch(`${ADMIN_ORIGIN}/admin/api/auth/get-session`, {
      headers: { cookie: cookies },
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as { session?: unknown; user?: Record<string, unknown> } | null;
    const user = body?.session ? body.user : null;
    if (!user || typeof user.id !== 'string') return null;
    return {
      id: user.id,
      email: String(user.email ?? ''),
      role: String(user.role ?? 'viewer'),
      screens: String(user.screens ?? '').split(',').map((s) => s.trim()),
      mustChangePassword: user.mustChangePassword === true,
    };
  } catch (error) {
    // The panel unreachable means nobody can be told apart: the door stays shut.
    console.error(`[signed-in] could not ask the panel: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** May this login use the pendant tool? Owners, and editors given Create a pendant, once they have set their own password. */
export function mayMake(staff: Staff): boolean {
  if (staff.mustChangePassword) return false;
  return staff.role === 'owner' || (staff.role === 'editor' && staff.screens.includes('generate'));
}

/** For a route handler: the login making the call, or the response to send back instead (401 or 403). */
export async function makerOf(request: Request): Promise<Staff | Response> {
  const staff = await staffFrom(request.headers.get('cookie'));
  if (!staff) return Response.json({ success: false, error: 'Please sign in first.' }, { status: 401 });
  if (!mayMake(staff)) return Response.json({ success: false, error: 'Your login cannot make pendants. Ask an owner for access.' }, { status: 403 });
  return staff;
}

/** Who is calling one of the routes customers may use too: a team member who may make pendants, or a signed-in shop customer. */
export type Caller = { kind: 'staff'; staff: Staff } | { kind: 'customer'; phone: string };

/**
 * For the routes the shop's customer page shares with the tool (sketch,
 * product photo): a customer's bearer token (lib/customer-session.ts), else
 * a team member's sign-in. Anyone else gets the response to send back.
 */
export async function callerOf(request: Request): Promise<Caller | Response> {
  if (request.headers.get('authorization')?.startsWith('Bearer ')) {
    const phone = customerOf(request);
    if (phone) return { kind: 'customer', phone };
    return Response.json({ success: false, error: 'Please sign in with your mobile number again.', signIn: true }, { status: 401 });
  }
  const staff = await makerOf(request);
  return staff instanceof Response ? staff : { kind: 'staff', staff };
}
