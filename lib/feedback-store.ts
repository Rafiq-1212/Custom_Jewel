/**
 * Feedback, written by the tool (app/api/feedback) and read back for a
 * redraw (app/api/sketch). The admin panel reads the same table for its
 * Feedback screen. Unlike the cost ledger (lib/tracking.ts), a failure here
 * is reported: feedback the team typed must not vanish silently.
 */

import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { issuesFor, NOTE_MAX, type FeedbackStage } from './feedback';

if (typeof window !== 'undefined') {
  throw new Error('lib/feedback-store.ts was imported into a browser bundle. This module is server-only.');
}

let client: NeonQueryFunction<false, false> | null = null;
function db(): NeonQueryFunction<false, false> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
  client ??= neon(process.env.DATABASE_URL);
  return client;
}

export interface NewFeedback {
  generationId: string;
  stage: FeedbackStage;
  rating: 'good' | 'bad';
  issues: unknown;
  person: string | null;
  note: string;
  /** Who gave it: a team member, or a shop customer by their number. */
  userId: string | null;
  phone?: string | null;
}

/** Saves one piece of feedback; returns its id. Only known issue keys are kept. */
export async function recordFeedback(feedback: NewFeedback): Promise<number> {
  const issues = feedback.rating === 'bad' ? issuesFor(feedback.stage, feedback.issues) : [];
  const note = feedback.note.trim().slice(0, NOTE_MAX) || null;
  const [row] = await db()`
    insert into feedback (generation_id, stage, rating, issues, issue_labels, person, note, user_id, phone)
    values (${feedback.generationId}, ${feedback.stage}, ${feedback.rating}, ${issues.map((i) => i.key)}, ${issues.map((i) => i.label)},
            ${feedback.person}, ${note}, ${feedback.userId}, ${feedback.phone ?? null})
    returning id`;
  return Number(row.id);
}

/** A 👎 on a sketch, given against this drawing: what a redraw is to correct. */
export async function feedbackFor(id: number, generationId: string): Promise<{ issues: string[]; person: string | null; note: string | null } | null> {
  const [row] = await db()`
    select issues, person, note from feedback
    where id = ${id} and generation_id = ${generationId} and stage = 'sketch' and rating = 'bad'`;
  return row ? { issues: row.issues ?? [], person: row.person, note: row.note } : null;
}

/** Records the drawing a piece of feedback was turned into. */
export async function linkRedraw(id: number, job: string): Promise<void> {
  await db()`update feedback set redraw_job = ${job} where id = ${id}`;
}
