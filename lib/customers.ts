/**
 * Shop customers and their designs: sign-in codes, the number of designs
 * each phone may make (3, refilled from the admin panel), and the shop
 * settings the customer page shows. Unlike the cost ledger, a failure here
 * is reported: it decides whether someone may spend money.
 */

import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { keyedHash } from './customer-session';
import { LIMITS, MAX_ATTEMPTS, OTP_MINUTES, RESEND_SECONDS } from './otp';

if (typeof window !== 'undefined') {
  throw new Error('lib/customers.ts was imported into a browser bundle. This module is server-only.');
}

let client: NeonQueryFunction<false, false> | null = null;
function db(): NeonQueryFunction<false, false> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
  client ??= neon(process.env.DATABASE_URL);
  return client;
}

/** Why a code may not be sent now, in a sentence for the customer, or null if it may. */
export async function codeLimit(phone: string, ip: string | null): Promise<string | null> {
  const [row] = await db()`
    select
      (select count(*) from otp_requests where phone = ${phone} and created_at > now() - interval '1 hour')::int as phone_hour,
      (select count(*) from otp_requests where phone = ${phone} and created_at > now() - interval '1 day')::int as phone_day,
      (select count(*) from otp_requests where ${ip}::text is not null and ip = ${ip} and created_at > now() - interval '1 hour')::int as ip_hour,
      (select extract(epoch from now() - max(created_at)) from otp_requests where phone = ${phone})::float as since_last`;
  if (row.since_last !== null && row.since_last < RESEND_SECONDS) return `Please wait ${Math.ceil(RESEND_SECONDS - row.since_last)} seconds before asking for another code.`;
  if (row.phone_hour >= LIMITS.phoneHour || row.phone_day >= LIMITS.phoneDay || row.ip_hour >= LIMITS.ipHour) {
    return 'Too many codes asked for. Please try again in a while.';
  }
  return null;
}

export async function storeCode(phone: string, code: string, ip: string | null): Promise<void> {
  await db()`
    insert into otp_requests (phone, code_hash, ip, expires_at)
    values (${phone}, ${keyedHash(`${phone}:${code}`)}, ${ip}, now() + ${`${OTP_MINUTES} minutes`}::interval)`;
}

/** Checks a code against the newest live one for the phone. 'ok' uses it up; five wrong guesses kill it. */
export async function checkCode(phone: string, code: string): Promise<'ok' | 'wrong' | 'expired'> {
  const [live] = await db()`
    select id, code_hash, attempts from otp_requests
    where phone = ${phone} and consumed_at is null and expires_at > now()
    order by created_at desc limit 1`;
  if (!live) return 'expired';
  if (live.code_hash === keyedHash(`${phone}:${code}`)) {
    await db()`update otp_requests set consumed_at = now() where id = ${live.id}`;
    return 'ok';
  }
  const attempts = live.attempts + 1;
  await db()`update otp_requests set attempts = ${attempts}, consumed_at = case when ${attempts} >= ${MAX_ATTEMPTS} then now() else null end where id = ${live.id}`;
  return attempts >= MAX_ATTEMPTS ? 'expired' : 'wrong';
}

/** Records a signed-in customer; consent is only ever switched on here, never off. */
export async function signInCustomer(phone: string, source: string | null, consent: string | null): Promise<void> {
  const [limit] = await db()`select value from settings where key = 'tries_limit'`;
  const tries = Math.max(0, Number(limit?.value) || 3);
  await db()`
    insert into customers (phone, tries_limit, source, marketing_consent, consent_at, consent_text, last_seen_at)
    values (${phone}, ${tries}, ${source}, ${Boolean(consent)}, ${consent ? new Date().toISOString() : null}, ${consent}, now())
    on conflict (phone) do update set
      last_seen_at = now(),
      source = coalesce(customers.source, excluded.source),
      marketing_consent = customers.marketing_consent or excluded.marketing_consent,
      consent_at = coalesce(customers.consent_at, excluded.consent_at),
      consent_text = coalesce(customers.consent_text, excluded.consent_text)`;
}

export interface Allowance {
  used: number;
  limit: number;
  left: number;
}

export async function allowanceOf(phone: string): Promise<Allowance | null> {
  const [row] = await db()`select tries_used, tries_limit from customers where phone = ${phone}`;
  return row ? { used: row.tries_used, limit: row.tries_limit, left: Math.max(0, row.tries_limit - row.tries_used) } : null;
}

/** Takes one design from the customer's allowance, atomically; false when none is left. */
export async function takeTry(phone: string): Promise<boolean> {
  const rows = await db()`
    update customers set tries_used = tries_used + 1, last_seen_at = now()
    where phone = ${phone} and tries_used < tries_limit
    returning tries_used`;
  return rows.length > 0;
}

/** Gives a design back: the customer never loses one to our own failure. */
export async function refundTry(phone: string): Promise<void> {
  await db()`update customers set tries_used = greatest(0, tries_used - 1) where phone = ${phone}`;
}

/** Does this drawing belong to this customer? */
export async function ownsJob(phone: string, job: string): Promise<boolean> {
  const [row] = await db()`select 1 as yes from generations where id = ${job} and phone = ${phone}`;
  return Boolean(row);
}

/**
 * A drawing that came back out of frame may be drawn once more without using
 * a design: marked here when it happens, used up when the redo starts.
 */
export async function markRedoPending(job: string): Promise<void> {
  await db()`update generations set status = 'redo_pending' where id = ${job} and status = 'running'`;
}

export async function takeRedo(phone: string, job: string): Promise<boolean> {
  const rows = await db()`update generations set status = 'redone' where id = ${job} and phone = ${phone} and status = 'redo_pending' returning id`;
  return rows.length > 0;
}

/** The drawing a sketch's folder came from, if this customer made it. For product photos. */
export async function customerFolderJob(phone: string, folder: string): Promise<string | null> {
  const [row] = await db()`select id from generations where phone = ${phone} and right(folder, 10) = right(${folder}, 10) order by created_at desc limit 1`;
  return row?.id ?? null;
}

/** Product photos already made from one design's folder. */
export async function photosOf(folder: string): Promise<number> {
  const [row] = await db()`select count(*)::int as n from events where kind = 'product_photo' and right(folder, 10) = right(${folder}, 10)`;
  return row.n;
}

export async function setting(key: string): Promise<string> {
  const [row] = await db()`select value from settings where key = ${key}`;
  return row?.value ?? '';
}

export interface CustomerDesign {
  job: string;
  createdAt: string;
  category: string;
  folder: string;
}

/** A customer's finished designs, newest first. */
export async function designsOf(phone: string): Promise<CustomerDesign[]> {
  const rows = await db()`
    select id, created_at, category, folder from generations
    where phone = ${phone} and folder is not null and status = 'done'
    order by created_at desc limit 20`;
  return rows.map((r) => ({ job: r.id, createdAt: r.created_at, category: r.category, folder: r.folder }));
}

/** Where a customer's own design is kept, or null if it is not theirs. */
export async function folderOf(phone: string, job: string): Promise<string | null> {
  const [row] = await db()`select folder from generations where id = ${job} and phone = ${phone} and folder is not null`;
  return row?.folder ?? null;
}

/** A design's folder, whoever made it: for its picture link on a cart line (key checked by the caller). */
export async function folderOfJob(job: string): Promise<string | null> {
  const [row] = await db()`select folder from generations where id = ${job} and folder is not null`;
  return row?.folder ?? null;
}

/** The saved file of one of a design's pictures: its sketch, or its newest product photo in a metal. */
export async function pictureOf(folder: string, kind: 'sketch' | 'photo', metal: 'gold' | 'silver'): Promise<string | null> {
  const [row] =
    kind === 'sketch'
      ? await db()`select file from events where kind = 'sketch_done' and file is not null and right(folder, 10) = right(${folder}, 10) order by id desc limit 1`
      : await db()`select file from events where kind = 'product_photo' and file is not null and detail = ${metal} and right(folder, 10) = right(${folder}, 10) order by id desc limit 1`;
  return row?.file ?? null;
}
