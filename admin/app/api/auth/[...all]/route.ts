import { toNextJsHandler } from 'better-auth/next-js';
import { auth } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return toNextJsHandler(auth()).GET(request);
}

export async function POST(request: Request): Promise<Response> {
  // No public sign-up: accounts are made by scripts/seed-admin.mjs only.
  if (new URL(request.url).pathname.includes('/sign-up')) return new Response('Not found', { status: 404 });
  return toNextJsHandler(auth()).POST(request);
}
