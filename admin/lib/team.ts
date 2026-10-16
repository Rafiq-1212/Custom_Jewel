'use server';

/**
 * The Team screen's actions, for owners only. A login is made with a
 * temporary password, shown to the owner once and never stored readable; the
 * login must replace it at its first sign-in (app/set-password).
 */

import { randomInt } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { auth, requireOwner } from './auth';
import { db } from './db';
import { SCREENS, toRole, type Screen } from './access';

export interface TeamState {
  error: string | null;
  /** The temporary password just made, and for whom: shown once. */
  issued?: { email: string; password: string };
}

/** Twelve letters and digits in three groups, none easily misread (no 0/O, 1/l/I). */
function temporaryPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const group = () => Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join('');
  return `${group()}-${group()}-${group()}`;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function screensFrom(form: FormData): string {
  const known = new Set<string>(SCREENS.map((s) => s.key));
  return form
    .getAll('screens')
    .filter((s): s is Screen => typeof s === 'string' && known.has(s))
    .join(',');
}

async function owners(): Promise<number> {
  const [row] = await db()`select count(*)::int as n from "user" where role = 'owner'`;
  return row.n;
}

export async function createMember(_previous: TeamState, form: FormData): Promise<TeamState> {
  await requireOwner();
  const name = text(form, 'name');
  const email = text(form, 'email').toLowerCase();
  const role = toRole(text(form, 'role'));
  if (!name) return { error: 'Enter their name.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Enter a valid email address.' };
  const context = await auth().$context;
  const password = temporaryPassword();
  const screens = role === 'owner' ? '' : screensFrom(form);
  const [existing] = await db()`select id, role from "user" where email = ${email}`;
  if (existing && existing.role !== 'removed') return { error: 'There is already a login with that email.' };
  if (existing) {
    // Someone removed earlier, back again: the same person, so what they made stays theirs.
    await context.internalAdapter.updateUser(existing.id, { name, role, screens, mustChangePassword: true });
    await context.internalAdapter.linkAccount({ providerId: 'credential', accountId: existing.id, userId: existing.id, password: await context.password.hash(password) });
    revalidatePath('/team');
    return { error: null, issued: { email, password } };
  }
  const user = await context.internalAdapter.createUser(
    { email, name, emailVerified: false, role, screens, mustChangePassword: true },
    { method: 'admin' },
  );
  if (!user) return { error: 'The login could not be made. Please try again.' };
  await context.internalAdapter.linkAccount({ providerId: 'credential', accountId: user.id, userId: user.id, password: await context.password.hash(password) });
  revalidatePath('/team');
  return { error: null, issued: { email, password } };
}

/** Changes a login's role and screens. An owner's own role is not changed here, so there is always an owner. */
export async function updateMember(_previous: TeamState, form: FormData): Promise<TeamState> {
  const me = await requireOwner();
  const id = text(form, 'id');
  const role = toRole(text(form, 'role'));
  if (!id) return { error: 'That login was not found.' };
  if (id === me.id && role !== 'owner') return { error: 'You cannot change your own role. Make someone else an owner first, and ask them.' };
  const [current] = await db()`select role from "user" where id = ${id}`;
  if (!current) return { error: 'That login was not found.' };
  if (current.role === 'owner' && role !== 'owner' && (await owners()) <= 1) return { error: 'There must always be at least one owner.' };
  const context = await auth().$context;
  await context.internalAdapter.updateUser(id, { role, screens: role === 'owner' ? '' : screensFrom(form) });
  revalidatePath('/team');
  return { error: null };
}

/** A new temporary password for someone who forgot theirs. They are signed out everywhere and must change it at the next sign-in. */
export async function resetMemberPassword(_previous: TeamState, form: FormData): Promise<TeamState> {
  const me = await requireOwner();
  const id = text(form, 'id');
  if (id === me.id) return { error: 'Change your own password on the Account screen.' };
  const [user] = await db()`select email from "user" where id = ${id}`;
  if (!user) return { error: 'That login was not found.' };
  const context = await auth().$context;
  const password = temporaryPassword();
  await context.internalAdapter.updatePassword(id, await context.password.hash(password));
  await context.internalAdapter.updateUser(id, { mustChangePassword: true });
  await context.internalAdapter.deleteUserSessions(id);
  revalidatePath('/team');
  return { error: null, issued: { email: user.email, password } };
}

/**
 * Takes a login away: signed out everywhere, its password gone, so it can
 * never sign in again. The person's row stays, marked removed, so their name
 * stays on everything they made.
 */
export async function removeMember(_previous: TeamState, form: FormData): Promise<TeamState> {
  const me = await requireOwner();
  const id = text(form, 'id');
  if (id === me.id) return { error: 'You cannot remove your own login.' };
  const [user] = await db()`select role from "user" where id = ${id}`;
  if (!user) return { error: 'That login was not found.' };
  if (user.role === 'owner' && (await owners()) <= 1) return { error: 'There must always be at least one owner.' };
  const context = await auth().$context;
  await context.internalAdapter.deleteUserSessions(id);
  await context.internalAdapter.deleteAccounts(id);
  await context.internalAdapter.updateUser(id, { role: 'removed', screens: '', mustChangePassword: false });
  revalidatePath('/team');
  return { error: null };
}
