'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { homeOf } from './access';
import { auth, requireAdmin, requireEditor } from './auth';
import { db } from './db';

export interface FormState {
  error: string | null;
  saved?: boolean;
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export async function signIn(_previous: FormState, form: FormData): Promise<FormState> {
  const email = field(form, 'email');
  const password = field(form, 'password');
  if (!email || !password) return { error: 'Enter your email and password.' };
  try {
    await auth().api.signInEmail({ body: { email, password }, headers: await headers() });
  } catch {
    return { error: 'That email and password don\'t match.' };
  }
  // To the Dashboard (a login without it goes on to its first screen: lib/auth.ts).
  redirect('/');
}

export async function signOut(): Promise<void> {
  await auth().api.signOut({ headers: await headers() });
  redirect('/login');
}

/**
 * Replaces the signed-in admin's password. Every device is signed out,
 * this one included, and the sign-in page says to use the new password.
 */
export async function changePassword(_previous: FormState, form: FormData): Promise<FormState> {
  await requireAdmin();
  const current = field(form, 'current');
  const next = field(form, 'next');
  if (!current || !next) return { error: 'Enter your current password and a new one.' };
  if (next.length < 10) return { error: 'Use a new password of at least 10 characters.' };
  try {
    await auth().api.changePassword({ body: { currentPassword: current, newPassword: next, revokeOtherSessions: true }, headers: await headers() });
    await auth().api.signOut({ headers: await headers() }).catch(() => undefined);
  } catch {
    return { error: 'Your current password isn\'t right.' };
  }
  redirect('/login?changed=1');
}

/**
 * A new login's first sign-in: it replaces the temporary password the owner
 * gave it with its own, and is then let in. Other devices are signed out.
 */
export async function setFirstPassword(_previous: FormState, form: FormData): Promise<FormState> {
  const me = await requireAdmin({ passwordChange: true });
  const current = field(form, 'current');
  const next = field(form, 'next');
  const again = field(form, 'again');
  if (!current || !next) return { error: 'Enter the temporary password and a new one.' };
  if (next.length < 10) return { error: 'Use a new password of at least 10 characters.' };
  if (next !== again) return { error: 'The two new passwords are not the same.' };
  if (next === current) return { error: 'Choose a password different from the temporary one.' };
  try {
    await auth().api.changePassword({ body: { currentPassword: current, newPassword: next, revokeOtherSessions: true }, headers: await headers() });
  } catch {
    return { error: 'The temporary password isn\'t right.' };
  }
  const context = await auth().$context;
  await context.internalAdapter.updateUser(me.id, { mustChangePassword: false });
  redirect(homeOf(me));
}

/**
 * Refills a shop customer's designs: what they have used goes back to 0, and
 * their limit to the shop's (Customers → Shop settings). For someone who rang
 * the support number when they ran out. Recorded with who did it.
 */
export async function refillTries(form: FormData): Promise<void> {
  const me = await requireEditor('customers');
  const phone = field(form, 'phone');
  if (!phone) return;
  const [limit] = await db()`select value from settings where key = 'tries_limit'`;
  const tries = Math.max(1, Number(limit?.value) || 3);
  const [row] = await db()`update customers set tries_used = 0, tries_limit = greatest(tries_limit, ${tries}) where phone = ${phone} returning tries_limit`;
  if (row) await db()`insert into events (kind, detail, phone, user_id) values ('designs_added', ${`refilled to ${row.tries_limit}`}, ${phone}, ${me.id})`;
  revalidatePath('/customers');
}

/** Gives a shop customer extra designs on top of what they have left, also recorded with who did it. */
export async function addTries(form: FormData): Promise<void> {
  const me = await requireEditor('customers');
  const phone = field(form, 'phone');
  const extra = Number(field(form, 'extra'));
  if (!phone || !Number.isInteger(extra) || extra < 1 || extra > 20) return;
  const [row] = await db()`update customers set tries_limit = tries_limit + ${extra} where phone = ${phone} returning tries_limit`;
  if (row) await db()`insert into events (kind, detail, phone, user_id) values ('designs_added', ${`+${extra}`}, ${phone}, ${me.id})`;
  revalidatePath('/customers');
}

/** The support number shown to a customer who has used their designs, and how many designs a new customer gets. */
export async function saveShopSettings(_previous: FormState, form: FormData): Promise<FormState> {
  await requireEditor('customers');
  const phone = field(form, 'supportPhone').slice(0, 40);
  const tries = Number(field(form, 'triesLimit'));
  if (phone && !/^[+\d][\d\s-]{6,}$/.test(phone)) return { error: 'Enter the support number as digits, e.g. +91 98765 43210.' };
  if (!Number.isInteger(tries) || tries < 1 || tries > 50) return { error: 'Designs per customer must be between 1 and 50.' };
  await db()`insert into settings (key, value, updated_at) values ('support_phone', ${phone}, now()) on conflict (key) do update set value = excluded.value, updated_at = now()`;
  await db()`insert into settings (key, value, updated_at) values ('tries_limit', ${String(tries)}, now()) on conflict (key) do update set value = excluded.value, updated_at = now()`;
  revalidatePath('/customers');
  return { error: null, saved: true };
}

/**
 * Marks a piece of feedback fixed, with what was changed, or opens it again.
 * Fixed is for when the tool itself was changed so the problem should not
 * come back; whether it does shows in the counts on the Feedback screen.
 */
export async function setFeedbackStatus(form: FormData): Promise<void> {
  const me = await requireEditor('feedback');
  const id = Number(field(form, 'id'));
  const status = field(form, 'status') === 'fixed' ? 'fixed' : 'open';
  const resolution = field(form, 'resolution').slice(0, 400) || null;
  if (!Number.isInteger(id)) return;
  if (status === 'fixed') {
    await db()`update feedback set status = 'fixed', resolved_at = now(), resolved_by = ${me.id}, resolution = ${resolution} where id = ${id}`;
  } else {
    await db()`update feedback set status = 'open', resolved_at = null, resolved_by = null, resolution = null where id = ${id}`;
  }
  revalidatePath('/feedback');
}
