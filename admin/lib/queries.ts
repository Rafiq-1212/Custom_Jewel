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
export function since(range: Range): string {
  return range === 'all' ? '1970-01-01' : new Date(Date.now() - Number(range) * 86_400_000).toISOString();
}

export interface Totals {
  tried: number;
  done: number;
  failed: number;
  running: number;
  abandoned: number;
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
      (select count(*) from generations where created_at >= ${from} and status = 'running' and created_at >= now() - interval '1 hour')::int as running,
      (select count(*) from generations where created_at >= ${from} and status = 'running' and created_at < now() - interval '1 hour')::int as abandoned,
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
    abandoned: row.abandoned,
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
  /** The team member who made it, by name; null for what was made before the tool needed a login. */
  madeBy: string | null;
  madeById: string | null;
  /** The drawing this one redraws, from feedback; null for a first drawing. */
  parentId: string | null;
  corrections: string | null;
  /** 👍 and 👎 given on its sketch. */
  liked: number;
  disliked: number;
  /** Paid orders on the shop made from it. */
  ordered: number;
}

/**
 * A drawing is collected two to four minutes after it starts, by the browser
 * that started it. One still running after this long was left: the tab was
 * closed, and nobody will come back for it.
 */
const ABANDONED_AFTER_MS = 60 * 60 * 1000;

function toGeneration(r: Record<string, unknown>): Generation {
  const left = r.status === 'running' && Date.now() - new Date(r.created_at as string).getTime() > ABANDONED_AFTER_MS;
  return {
    id: r.id as string,
    createdAt: r.created_at as string,
    finishedAt: r.finished_at as string | null,
    phone: r.phone as string | null,
    category: r.category as string,
    status: left ? 'abandoned' : (r.status as string),
    folder: r.folder as string | null,
    error: r.error as string | null,
    costUsd: Number(r.cost_usd),
    photos: Number(r.photos),
    files: Number(r.files),
    sketchFile: r.sketch_file as string | null,
    madeBy: (r.made_by as string | null) ?? null,
    madeById: (r.created_by as string | null) ?? null,
    parentId: (r.parent_id as string | null) ?? null,
    corrections: (r.corrections as string | null) ?? null,
    liked: Number(r.liked ?? 0),
    disliked: Number(r.disliked ?? 0),
    ordered: Number(r.ordered ?? 0),
  };
}

/** The newest generations, each with what it has cost so far, what was made from it, and who made it; only `by`'s when given. */
export async function generations(limit = 200, by: string | null = null, phone: string | null = null): Promise<Generation[]> {
  const rows = await db()`
    select g.*, fb.liked, fb.disliked, (select count(*) from orders o where o.generation_id = g.id)::int as ordered, coalesce(c.cost_usd, 0)::float as cost_usd, coalesce(c.photos, 0)::int as photos, coalesce(c.files, 0)::int as files, s.file as sketch_file, coalesce(u.name, case when g.created_by is not null then 'Removed login' when g.phone is not null then 'Shop customer' end) as made_by
    from generations g
    left join "user" u on u.id = g.created_by
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
    left join lateral (
      select count(*) filter (where f.rating = 'good')::int as liked, count(*) filter (where f.rating = 'bad')::int as disliked
      from feedback f where f.generation_id = g.id and f.stage = 'sketch'
    ) fb on true
    where (${by}::text is null or g.created_by = ${by}) and (${phone}::text is null or g.phone = ${phone})
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
  /** Who did this step, by name. */
  by: string | null;
}

/** One generation and every step that belongs to it, oldest first. */
export async function generation(id: string): Promise<{ generation: Generation; steps: Step[] } | null> {
  const found = (await generations(1000)).find((g) => g.id === id);
  if (!found) return null;
  const order = found.folder ? found.folder.slice(-10) : '';
  const rows = await db()`
    select e.id, e.created_at, e.kind, e.detail, e.cost_usd::float as cost_usd, e.file, coalesce(u.name, case when e.user_id is not null then 'Removed login' when e.phone is not null then 'Customer' end) as by
    from events e left join "user" u on u.id = e.user_id
    where e.generation_id = ${id} or (${order} <> '' and right(e.folder, 10) = ${order})
    order by e.id`;
  return {
    generation: found,
    steps: rows.map((r) => ({ id: Number(r.id), createdAt: r.created_at, kind: r.kind, detail: r.detail, costUsd: r.cost_usd, file: r.file, by: r.by })),
  };
}



export interface MemberActivity {
  id: string | null;
  name: string;
  role: string | null;
  designs: number;
  finished: number;
  photos: number;
  files: number;
  spendUsd: number;
  lastAt: string | null;
}

/**
 * What each team member made in the period: designs started and finished,
 * product photos, production files, and what it all cost. Steps from before
 * the tool needed a login are one line of their own.
 */
export async function activityByMember(range: Range): Promise<MemberActivity[]> {
  const rows = await db()`
    select e.user_id as id,
           coalesce(u.name, case when e.phone is not null then 'Shop customers' when e.user_id is null then 'Before team logins' else 'Removed login' end) as name,
           u.role,
           count(*) filter (where e.kind = 'sketch_start')::int as designs,
           count(*) filter (where e.kind = 'sketch_done')::int as finished,
           count(*) filter (where e.kind = 'product_photo')::int as photos,
           count(*) filter (where e.kind = 'production_files')::int as files,
           coalesce(sum(e.cost_usd), 0)::float as spend_usd,
           max(e.created_at) as last_at
    from events e left join "user" u on u.id = e.user_id
    where e.created_at >= ${since(range)}
    group by e.user_id, u.name, u.role, e.phone is not null
    order by spend_usd desc`;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    role: r.role,
    designs: r.designs,
    finished: r.finished,
    photos: r.photos,
    files: r.files,
    spendUsd: r.spend_usd,
    lastAt: r.last_at,
  }));
}

/** Everyone who has made something, for the Designs filter. */
export async function makers(): Promise<{ id: string; name: string }[]> {
  const rows = await db()`
    select distinct u.id, u.name from generations g join "user" u on u.id = g.created_by order by u.name`;
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: string;
  screens: string;
  mustChangePassword: boolean;
  createdAt: string;
  lastSeenAt: string | null;
}

/** Everyone with a login, owners first (shown on Team, which only owners open). */
export async function teamMembers(): Promise<TeamMember[]> {
  const rows = await db()`
    select u.id, u.name, u.email, u.role, u.screens, u."mustChangePassword", u."createdAt",
           (select max(s."updatedAt") from session s where s."userId" = u.id) as last_seen
    from "user" u
    where u.role <> 'removed'
    order by case u.role when 'owner' then 0 when 'editor' then 1 else 2 end, u."createdAt"`;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.role,
    screens: r.screens ?? '',
    mustChangePassword: r.mustChangePassword === true,
    createdAt: r.createdAt,
    lastSeenAt: r.last_seen,
  }));
}

export interface Feedback {
  id: number;
  createdAt: string;
  generationId: string | null;
  stage: string;
  rating: string;
  issues: string[];
  issueLabels: string[];
  person: string | null;
  note: string | null;
  by: string | null;
  redrawJob: string | null;
  status: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolution: string | null;
  sketchFile: string | null;
  category: string | null;
}

function toFeedback(r: Record<string, unknown>): Feedback {
  return {
    id: Number(r.id),
    createdAt: r.created_at as string,
    generationId: r.generation_id as string | null,
    stage: r.stage as string,
    rating: r.rating as string,
    issues: (r.issues as string[]) ?? [],
    issueLabels: (r.issue_labels as string[]) ?? [],
    person: r.person as string | null,
    note: r.note as string | null,
    by: r.by as string | null,
    redrawJob: r.redraw_job as string | null,
    status: r.status as string,
    resolvedAt: r.resolved_at as string | null,
    resolvedBy: r.resolved_by_name as string | null,
    resolution: r.resolution as string | null,
    sketchFile: r.sketch_file as string | null,
    category: r.category as string | null,
  };
}

export interface FeedbackFilter {
  stage?: string | null;
  issue?: string | null;
  status?: string | null;
  rating?: string | null;
  by?: string | null;
}

/** Feedback, newest first, with the sketch it is about and who gave it. */
export async function feedbackList(filter: FeedbackFilter = {}, limit = 300): Promise<Feedback[]> {
  const rows = await db()`
    select f.*, u.name as by, r.name as resolved_by_name, g.category, s.file as sketch_file
    from feedback f
    left join "user" u on u.id = f.user_id
    left join "user" r on r.id = f.resolved_by
    left join generations g on g.id = f.generation_id
    left join lateral (
      select file from events e where e.generation_id = f.generation_id and e.kind = 'sketch_done' and e.file is not null order by e.id desc limit 1
    ) s on true
    where (${filter.stage ?? null}::text is null or f.stage = ${filter.stage ?? null})
      and (${filter.issue ?? null}::text is null or ${filter.issue ?? null} = any(f.issues))
      and (${filter.status ?? null}::text is null or f.status = ${filter.status ?? null})
      and (${filter.rating ?? null}::text is null or f.rating = ${filter.rating ?? null})
      and (${filter.by ?? null}::text is null or f.user_id = ${filter.by ?? null})
    order by f.created_at desc
    limit ${limit}`;
  return rows.map(toFeedback);
}

export async function feedbackOnDesign(id: string): Promise<Feedback[]> {
  const rows = await db()`
    select f.*, u.name as by, r.name as resolved_by_name, null as category, null as sketch_file
    from feedback f left join "user" u on u.id = f.user_id left join "user" r on r.id = f.resolved_by
    where f.generation_id = ${id}
    order by f.created_at`;
  return rows.map(toFeedback);
}

export interface IssueCount {
  stage: string;
  issue: string;
  label: string;
  open: number;
  total: number;
  last: string;
}

/** How often each problem has been reported, the most common first. */
export async function issueCounts(): Promise<IssueCount[]> {
  const rows = await db()`
    select f.stage, i.key as issue, max(i.label) as label,
           count(*) filter (where f.status = 'open')::int as open, count(*)::int as total, max(f.created_at) as last
    from feedback f
    cross join lateral unnest(f.issues, f.issue_labels) as i(key, label)
    where f.rating = 'bad'
    group by f.stage, i.key
    order by open desc, total desc`;
  return rows.map((r) => ({ stage: r.stage, issue: r.issue, label: r.label, open: r.open, total: r.total, last: r.last }));
}

export interface FeedbackTotals {
  rated: number;
  good: number;
  open: number;
  redraws: number;
  redrawsLiked: number;
}

/**
 * For the dashboard: of first drawings whose sketch was rated, how many were
 * right first time; what is still open; and how the redraws did.
 */
export async function feedbackTotals(range: Range): Promise<FeedbackTotals> {
  const from = since(range);
  const [row] = await db()`
    select
      (select count(distinct f.generation_id) from feedback f join generations g on g.id = f.generation_id
        where f.stage = 'sketch' and g.parent_id is null and f.created_at >= ${from})::int as rated,
      (select count(distinct f.generation_id) from feedback f join generations g on g.id = f.generation_id
        where f.stage = 'sketch' and g.parent_id is null and f.created_at >= ${from}
          and not exists (select 1 from feedback b where b.generation_id = f.generation_id and b.stage = 'sketch' and b.rating = 'bad'))::int as good,
      (select count(*) from feedback where status = 'open' and rating = 'bad')::int as open,
      (select count(*) from generations where parent_id is not null and created_at >= ${from})::int as redraws,
      (select count(distinct g.id) from generations g join feedback f on f.generation_id = g.id and f.stage = 'sketch' and f.rating = 'good'
        where g.parent_id is not null and g.created_at >= ${from})::int as redraws_liked`;
  return { rated: row.rated, good: row.good, open: row.open, redraws: row.redraws, redrawsLiked: row.redraws_liked };
}

/** The drawings made by redrawing this one. */
export async function redrawsOf(id: string): Promise<{ id: string; createdAt: string; status: string }[]> {
  const rows = await db()`select id, created_at, status from generations where parent_id = ${id} order by created_at`;
  return rows.map((r) => ({ id: r.id, createdAt: r.created_at, status: r.status }));
}

/** Everyone who has given feedback, for the filter. */
export async function feedbackGivers(): Promise<{ id: string; name: string }[]> {
  const rows = await db()`select distinct u.id, u.name from feedback f join "user" u on u.id = f.user_id order by u.name`;
  return rows.map((r) => ({ id: r.id, name: r.name }));
}
