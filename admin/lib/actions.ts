'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { auth, requireAdmin } from './auth';
import { db } from './db';

export interface FormState {
  error: string | null;
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

/** Gives a customer their tries back. */
export async function resetTries(form: FormData): Promise<void> {
  await requireAdmin();
  const phone = field(form, 'phone');
  if (!phone) return;
  await db()`update customers set tries_used = 0 where phone = ${phone}`;
  revalidatePath('/customers');
}
