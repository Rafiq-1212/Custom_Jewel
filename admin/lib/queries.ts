/**
 * Everything the panel reads from the ledger (../db/schema.sql).
 *
 * An order is known by the last part of its folder in the image store (a
 * short hash of its sketch): a product photo made the day after the sketch
 * is saved under that day, but under the same hash.
 */

import { db } from './db';

export type Range = '7' | '30' | 'all';

export function toRange(value: string | string[] | undefined): Range {
  return value === '7' || value === 'all' ? value : '30';
}

/** The start of a range, as something Postgres can compare a timestamp with. */
function since(range: Range): string {
  return range === 'all' ? '1970-01-01' : new Date(Date.now() - Number(range) * 86_400_000).toISOString();
}

export interface Totals {
  tried: number;
  done: number;
  failed: number;
  running: number;
  failedBeforeStart: number;
  redone: number;
  photos: number;
  files: number;
  spendUsd: number;
}

export async function totals(range: Range): Promise<Totals> {
  const from = since(range);
  const [row] = await db()`
    select
      (select count(*) from generations where created_at >= ${from})::int as tried,
      (select count(*) from generations where created_at >= ${from} and status = 'done')::int as done,
      (select count(*) from generations where created_at >= ${from} and status = 'failed')::int as failed,
      (select count(*) from generations where created_at >= ${from} and status = 'running')::int as running,
      (select count(*) from events where created_at >= ${from} and kind = 'sketch_failed' and generation_id is null)::int as failed_before_start,
      (select count(*) from events where created_at >= ${from} and kind = 'sketch_redo')::int as redone,
      (select count(*) from events where created_at >= ${from} and kind = 'product_photo')::int as photos,
      (select count(*) from events where created_at >= ${from} and kind = 'production_files')::int as files,
      (select coalesce(sum(cost_usd), 0) from events where created_at >= ${from})::float as spend_usd`;
  return {
    tried: row.tried,
    done: row.done,
    failed: row.failed,
    running: row.running,
    failedBeforeStart: row.failed_before_start,
    redone: row.redone,
    photos: row.photos,
    files: row.files,
    spendUsd: row.spend_usd,
  };
}

export interface Day {
  day: string;
  sketches: number;
  done: number;
  failed: number;
  photos: number;
  files: number;
  spendUsd: number;
}

/** The last fortnight, a row per day (Indian time), newest first. */
export async function byDay(): Promise<Day[]> {
  const rows = await db()`
    select
      to_char(date_trunc('day', created_at at time zone 'Asia/Kolkata'), 'YYYY-MM-DD') as day,
      count(*) filter (where kind = 'sketch_start')::int as sketches,
      count(*) filter (where kind = 'sketch_done')::int as done,
      count(*) filter (where kind = 'sketch_failed')::int as failed,
      count(*) filter (where kind = 'product_photo')::int as photos,
      count(*) filter (where kind = 'production_files')::int as files,
      coalesce(sum(cost_usd), 0)::float as spend_usd
    from events
    where created_at >= now() - interval '14 days'
    group by 1
    order by 1 desc`;
  return rows.map((r) => ({ day: r.day, sketches: r.sketches, done: r.done, failed: r.failed, photos: r.photos, files: r.files, spendUsd: r.spend_usd }));
}

export interface SpendLine {
  kind: string;
  count: number;
  spendUsd: number;
}

export async function spendByStep(range: Range): Promise<SpendLine[]> {
  const rows = await db()`
    select kind, count(*)::int as count, coalesce(sum(cost_usd), 0)::float as spend_usd
    from events where created_at >= ${since(range)}
    group by kind order by spend_usd desc`;
  return rows.map((r) => ({ kind: r.kind, count: r.count, spendUsd: r.spend_usd }));
}

export interface Failure {
  createdAt: string;
  detail: string | null;
  generationId: string | null;
}

export async function recentFailures(): Promise<Failure[]> {
  const rows = await db()`
    select created_at, detail, generation_id from events
    where kind = 'sketch_failed' order by id desc limit 8`;
  return rows.map((r) => ({ createdAt: r.created_at, detail: r.detail, generationId: r.generation_id }));
}

export interface Generation {
  id: string;
  createdAt: string;
  finishedAt: string | null;
  phone: string | null;
  category: string;
  status: string;
  folder: string | null;
  error: string | null;
  costUsd: number;
  photos: number;
  files: number;
  sketchFile: string | null;
}

function toGeneration(r: Record<string, unknown>): Generation {
  return {
    id: r.id as string,
    createdAt: r.created_at as string,
    finishedAt: r.finished_at as string | null,
    phone: r.phone as string | null,
    category: r.category as string,
    status: r.status as string,
    folder: r.folder as string | null,
    error: r.error as string | null,
    costUsd: Number(r.cost_usd),
    photos: Number(r.photos),
    files: Number(r.files),
    sketchFile: r.sketch_file as string | null,
  };
}

/** The newest generations, each with what it has cost so far and what was made from it. */
export async function generations(limit = 200): Promise<Generation[]> {
  const rows = await db()`
    select g.*, coalesce(c.cost_usd, 0)::float as cost_usd, coalesce(c.photos, 0)::int as photos, coalesce(c.files, 0)::int as files, s.file as sketch_file
    from generations g
    left join lateral (
      select sum(cost_usd) as cost_usd,
             count(*) filter (where kind = 'product_photo') as photos,
             count(*) filter (where kind = 'production_files') as files
      from events e
      where e.generation_id = g.id or (g.folder is not null and right(e.folder, 10) = right(g.folder, 10))
    ) c on true
    left join lateral (
      select file from events e where e.generation_id = g.id and e.kind = 'sketch_done' and e.file is not null order by e.id desc limit 1
    ) s on true
    order by g.created_at desc
    limit ${limit}`;
  return rows.map(toGeneration);
}

export interface Step {
  id: number;
  createdAt: string;
  kind: string;
  detail: string | null;
  costUsd: number;
  file: string | null;
}

/** One generation and every step that belongs to it, oldest first. */
export async function generation(id: string): Promise<{ generation: Generation; steps: Step[] } | null> {
  const found = (await generations(1000)).find((g) => g.id === id);
  if (!found) return null;
  const order = found.folder ? found.folder.slice(-10) : '';
  const rows = await db()`
    select id, created_at, kind, detail, cost_usd::float as cost_usd, file from events
    where generation_id = ${id} or (${order} <> '' and right(folder, 10) = ${order})
    order by id`;
  return {
    generation: found,
    steps: rows.map((r) => ({ id: Number(r.id), createdAt: r.created_at, kind: r.kind, detail: r.detail, costUsd: r.cost_usd, file: r.file })),
  };
}

export interface Customer {
  phone: string;
  triesUsed: number;
  triesLimit: number;
  createdAt: string;
  lastSeenAt: string;
  generations: number;
  orders: number;
}

export async function customers(): Promise<Customer[]> {
  const rows = await db()`
    select c.*,
      (select count(*) from generations g where g.phone = c.phone)::int as generations,
      (select count(*) from orders o where o.phone = c.phone)::int as orders
    from customers c order by c.last_seen_at desc limit 500`;
  return rows.map((r) => ({
    phone: r.phone,
    triesUsed: r.tries_used,
    triesLimit: r.tries_limit,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    generations: r.generations,
    orders: r.orders,
  }));
}

export interface Order {
  id: string;
  createdAt: string;
  phone: string | null;
  folder: string | null;
  amount: number;
  currency: string;
}

export async function revenue(range: Range): Promise<{ orders: Order[]; total: number; count: number; fromGenerations: number }> {
  const from = since(range);
  const rows = await db()`select * from orders where created_at >= ${from} order by created_at desc limit 200`;
  const [sum] = await db()`
    select coalesce(sum(amount), 0)::float as total, count(*)::int as count, count(folder)::int as from_generations
    from orders where created_at >= ${from}`;
  return {
    orders: rows.map((r) => ({ id: r.id, createdAt: r.created_at, phone: r.phone, folder: r.folder, amount: Number(r.amount), currency: r.currency })),
    total: sum.total,
    count: sum.count,
    fromGenerations: sum.from_generations,
  };
}
