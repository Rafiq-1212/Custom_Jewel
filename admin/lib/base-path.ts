/**
 * Where the panel lives: true-b.vercel.app/admin. The pendant tool's site
 * hands every /admin request on to this app (next.config.ts at the repo
 * root), so the panel and the tool share one address and one sign-in cookie.
 * Next adds this to <Link> and redirect(); a plain href or src needs it too.
 */
export const BASE_PATH = '/admin';
