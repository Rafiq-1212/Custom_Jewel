/**
 * Sign-in for the admin panel, with Better Auth: email and password, sessions
 * in the shared database.
 *
 * Nobody can sign themselves up. The public sign-up address is closed
 * (app/api/auth/[...all]/route.ts). Logins are made by an owner on the Team
 * screen, with a temporary password that must be changed at the first
 * sign-in; the very first owner is made by scripts/seed-admin.mjs. Roles and
 * screens: lib/access.ts.
 */

import { betterAuth } from 'better-auth';
import { nextCookies } from 'better-auth/next-js';
import { Pool } from '@neondatabase/serverless';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { canEdit, canSee, homeOf, toRole, toScreens, type Member, type Screen } from './access';

function create() {
  return betterAuth({
    database: new Pool({ connectionString: process.env.DATABASE_URL }),
    // Reached through the tool's address as well as its own. (No basePath
    // here: Next hands the route handler its path without /admin.)
    trustedOrigins: ['https://true-b.vercel.app', 'https://true-b-admin.vercel.app', 'http://localhost:3011', 'http://localhost:3012'],
    emailAndPassword: { enabled: true, minPasswordLength: 10 },
    // Kept on the user's own row, set only by the panel (never by a sign-in
    // request), and returned with the session, so the pendant tool can read
    // them too (lib/access.ts).
    user: {
      additionalFields: {
        role: { type: 'string', defaultValue: 'viewer', input: false },
        screens: { type: 'string', defaultValue: '', input: false },
        mustChangePassword: { type: 'boolean', defaultValue: false, input: false },
      },
    },
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

/**
 * The signed-in login, or a redirect to the sign-in page. Called by every
 * page and action in the panel. A login still on its temporary password is
 * sent to set its own first, except by that page itself.
 */
export async function requireAdmin({ passwordChange = false } = {}): Promise<Member> {
  const session = await auth().api.getSession({ headers: await headers() });
  if (!session) redirect('/login');
  const user = session.user as typeof session.user & { role?: unknown; screens?: unknown; mustChangePassword?: unknown };
  const member: Member = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: toRole(user.role),
    screens: toScreens(user.screens),
    mustChangePassword: user.mustChangePassword === true,
  };
  // A removed login has no password and no sessions; this is only belt and braces.
  if (user.role === 'removed') redirect('/login');
  if (member.mustChangePassword && !passwordChange) redirect('/set-password');
  return member;
}

/** The signed-in login if it may see `screen`; otherwise it is sent to a screen it may see. */
export async function requireScreen(screen: Screen): Promise<Member> {
  const member = await requireAdmin();
  if (!canSee(member, screen)) redirect(homeOf(member));
  return member;
}

/** For actions that change something: an owner or an editor who may see `screen`. */
export async function requireEditor(screen: Screen): Promise<Member> {
  const member = await requireScreen(screen);
  if (!canEdit(member)) redirect(homeOf(member));
  return member;
}

/** For Team: owners only. */
export async function requireOwner(): Promise<Member> {
  const member = await requireAdmin();
  if (member.role !== 'owner') redirect(homeOf(member));
  return member;
}
