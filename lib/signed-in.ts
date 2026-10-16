/**
 * Whether the visitor is signed in to the admin panel. The whole tool is for
 * the shop's staff: its page and every route that costs money or hands out
 * customers' pictures are closed to anyone who is not.
 *
 * The panel owns the sign-in (Better Auth, admin/lib/auth.ts). Its cookie
 * is set on this site, because the panel is served here at /admin, so the
 * tool passes the visitor's cookies to the panel and asks it. One short call
 * per request; the sketch itself takes minutes.
 */

import { ADMIN_ORIGIN } from './admin-origin';

/** Better Auth's session cookie, with or without the __Secure- prefix it gets over https. */
const SESSION_COOKIE = /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/;
const TIMEOUT_MS = 5000;

export async function isSignedIn(cookies: string | null): Promise<boolean> {
  if (!cookies || !SESSION_COOKIE.test(cookies)) return false;
  try {
    const response = await fetch(`${ADMIN_ORIGIN}/admin/api/auth/get-session`, {
      headers: { cookie: cookies },
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const body = (await response.json().catch(() => null)) as { session?: unknown } | null;
    return Boolean(body?.session);
  } catch (error) {
    // The panel unreachable means nobody can be told apart: the door stays shut.
    console.error(`[signed-in] could not ask the panel: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** For a route handler: a 401 to send back, or null when the caller is signed in. */
export async function refuseUnlessSignedIn(request: Request): Promise<Response | null> {
  if (await isSignedIn(request.headers.get('cookie'))) return null;
  return Response.json({ success: false, error: 'Please sign in first.' }, { status: 401 });
}
