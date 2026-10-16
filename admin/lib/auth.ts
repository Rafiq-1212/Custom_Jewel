/**
 * Sign-in for the admin panel, with Better Auth: email and password, sessions
 * in the shared database.
 *
 * Nobody can sign themselves up. The public sign-up address is closed
 * (app/api/auth/[...all]/route.ts); the one way an account is made is
 * scripts/seed-admin.mjs, run by whoever runs the project. The password is
 * changed from the Account screen.
 */

import { betterAuth } from 'better-auth';
import { nextCookies } from 'better-auth/next-js';
import { Pool } from '@neondatabase/serverless';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { BASE_PATH } from './base-path';

function create() {
  return betterAuth({
    database: new Pool({ connectionString: process.env.DATABASE_URL }),
    // Served under the panel's path, and reached through the tool's address as well as its own.
    basePath: `${BASE_PATH}/api/auth`,
    trustedOrigins: ['https://true-b.vercel.app', 'https://true-b-admin.vercel.app', 'http://localhost:3011', 'http://localhost:3012'],
    emailAndPassword: { enabled: true, minPasswordLength: 10 },
    session: { expiresIn: 60 * 60 * 24 * 7 },
    // Lets a sign-in made from a server action set its cookie. Must stay last.
    plugins: [nextCookies()],
  });
}

let instance: ReturnType<typeof create> | null = null;

/** Made on first use: `next build` loads this with no database or secret set. */
export function auth(): ReturnType<typeof create> {
  instance ??= create();
  return instance;
}

/** The signed-in admin, or a redirect to the sign-in page. Called by every page and action in the panel. */
export async function requireAdmin(): Promise<{ email: string; name: string }> {
  const session = await auth().api.getSession({ headers: await headers() });
  if (!session) redirect('/login');
  return { email: session.user.email, name: session.user.name };
}
