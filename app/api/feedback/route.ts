/**
 * POST /api/feedback — the team's 👍 or 👎 on a sketch, a product photo or a
 * set of production files, with what was wrong (lib/feedback.ts). Saved
 * against the design, under whoever gave it; a sketch's 👎 can then be
 * redrawn from it (POST /api/sketch, action=redraw).
 *
 *   { job, stage, rating: 'good' | 'bad', issues: string[], person, note } -> { id }
 */

import { isStage, NOTE_MAX, PEOPLE } from '@/lib/feedback';
import { recordFeedback } from '@/lib/feedback-store';
import { makerOf } from '@/lib/signed-in';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const JOB_NAME = /^batches\/[A-Za-z0-9_-]{1,128}$/;

function fail(message: string, status: number): Response {
  return Response.json({ success: false, error: message }, { status });
}

export async function POST(request: Request): Promise<Response> {
  const maker = await makerOf(request);
  if (maker instanceof Response) return maker;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return fail('Something went wrong. Please try again.', 400);

  const { job, stage, rating, issues, person, note } = body;
  if (typeof job !== 'string' || !JOB_NAME.test(job)) return fail('This sketch can\'t take feedback. Please make a new one.', 400);
  if (!isStage(stage)) return fail('Something went wrong. Please try again.', 400);
  if (rating !== 'good' && rating !== 'bad') return fail('Choose 👍 or 👎 first.', 400);
  const text = typeof note === 'string' ? note : '';
  if (text.length > NOTE_MAX) return fail(`Keep the note under ${NOTE_MAX} characters.`, 400);
  if (rating === 'bad' && (!Array.isArray(issues) || issues.length === 0) && !text.trim()) {
    return fail('Tick what was wrong, or write a note.', 400);
  }
  const who = PEOPLE.find((p) => p.value === person)?.value ?? null;

  try {
    const id = await recordFeedback({ generationId: job, stage, rating, issues, person: who, note: text, userId: maker.id });
    return Response.json({ success: true, id });
  } catch (error) {
    console.error(`[feedback] could not save: ${error instanceof Error ? error.message : String(error)}`);
    return fail('The feedback couldn\'t be saved. Please try again.', 502);
  }
}
