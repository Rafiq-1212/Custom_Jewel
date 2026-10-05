'use server';

import { timingSafeEqual } from 'node:crypto';
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

/** Whether the first account still has to be made. */
export async function needsSetup(): Promise<boolean> {
  const rows = await db()`select count(*)::int as n from "user"`;
  return rows[0].n === 0;
}

function sameCode(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Makes the first admin account. Works once: only while there are no accounts, and only with the setup code. */
export async function setUp(_previous: FormState, form: FormData): Promise<FormState> {
  const code = field(form, 'code');
  const name = field(form, 'name');
  const email = field(form, 'email');
  const password = field(form, 'password');
  const expected = process.env.ADMIN_SETUP_CODE ?? '';
  if (!(await needsSetup())) return { error: 'Setup is already done. Sign in instead.' };
  if (!expected || !sameCode(code, expected)) return { error: 'That setup code isn\'t right.' };
  if (!name || !email.includes('@')) return { error: 'Enter your name and a real email address.' };
  if (password.length < 10) return { error: 'Use a password of at least 10 characters.' };
  try {
    await auth().api.signUpEmail({ body: { name, email, password } });
  } catch {
    return { error: 'We couldn\'t create the account. Please try again.' };
  }
  redirect('/login');
}

/** Gives a customer their tries back. */
export async function resetTries(form: FormData): Promise<void> {
  await requireAdmin();
  const phone = field(form, 'phone');
  if (!phone) return;
  await db()`update customers set tries_used = 0 where phone = ${phone}`;
  revalidatePath('/customers');
}
