/**
 * The tool's page is for signed-in staff only (lib/signed-in.ts). Anyone else
 * is sent to the panel's sign-in. A signed-in visitor opening the bare
 * address is taken to the tool inside the panel, with its menu; the panel
 * shows it in a frame (Sec-Fetch-Dest: iframe), which is let through, as is
 * ?full=1 for the tool on a page of its own.
 *
 * Pages only: the API routes check for themselves (lib/signed-in.ts), because
 * a proxy buffers request bodies and the production-files request can be
 * larger than its limit.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { isSignedIn } from './lib/signed-in';

export async function proxy(request: NextRequest) {
  if (!(await isSignedIn(request.headers.get('cookie')))) {
    return NextResponse.redirect(new URL('/admin/login', request.url));
  }
  const framed = request.headers.get('sec-fetch-dest') === 'iframe';
  if (request.nextUrl.pathname === '/' && !framed && !request.nextUrl.searchParams.has('full')) {
    return NextResponse.redirect(new URL('/admin/generate', request.url));
  }
  return NextResponse.next();
}

export const config = {
  // Everything but the panel, the API, and Next's and the public folder's files.
  matcher: ['/((?!admin|api|_next/static|_next/image|favicon\\.ico|.*\\.[a-z0-9]+$).*)'],
};
