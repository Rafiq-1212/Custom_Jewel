'use client';

/**
 * 👍 or 👎 on what the tool just made, with what was wrong (lib/feedback.ts).
 * Saved against the design and the person giving it, and read in the admin
 * panel's Feedback screen. Under a sketch, a 👎 can also be turned straight
 * into a redraw with those corrections: the drawing step alone, about ₹5 and
 * a few minutes, never started without the button being pressed.
 */

import * as React from 'react';
import { ISSUES, NOTE_MAX, PEOPLE, type FeedbackStage, type Person } from '@/lib/feedback';
import { runRedraw, SketchError, type Sketch, type SketchStage } from '@/lib/sketch-client';

const NOUN: Record<FeedbackStage, string> = { sketch: 'this sketch', product_photo: 'the product photo', production_files: 'the production files' };
/** Styles with more than one person, where it helps to say who a correction is for. */
const GROUPS = new Set(['couple', 'family', 'full-size', 'half-size']);

const STAGE_TEXT: Record<SketchStage, string> = {
  'touching-up': 'Starting the redraw…',
  inking: 'Redrawing with your corrections. This takes about 2 to 4 minutes.',
  finishing: 'Almost there…',
};

async function save(body: Record<string, unknown>): Promise<number> {
  const response = await fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = (await response.json().catch(() => null)) as { success?: boolean; id?: number; error?: string } | null;
  if (!response.ok || !json?.success || typeof json.id !== 'number') throw new Error(json?.error ?? 'The feedback couldn\'t be saved. Please try again.');
  return json.id;
}

export function FeedbackPanel({
  job,
  stage,
  category,
  image,
  onRedrawn,
}: {
  /** The design: the sketch's job. Without it there is nothing to attach feedback to. */
  job: string | null;
  stage: FeedbackStage;
  category?: string;
  /** The sketch as it is now, shown as "before" once a redraw comes back. */
  image?: string;
  /** For a sketch: the redrawn sketch, which replaces the current one. */
  onRedrawn?: (sketch: Sketch) => void;
}) {
  const [rating, setRating] = React.useState<'good' | 'bad' | null>(null);
  const [issues, setIssues] = React.useState<string[]>([]);
  const [person, setPerson] = React.useState<Person>('all');
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState<'saving' | 'redrawing' | null>(null);
  const [stageNow, setStageNow] = React.useState<SketchStage>('inking');
  const [saved, setSaved] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [before, setBefore] = React.useState<string | null>(null);
  const runRef = React.useRef(0);
  React.useEffect(() => () => void (runRef.current += 1), []);

  if (!job) return null;
  const canRedraw = stage === 'sketch' && Boolean(onRedrawn && category);

  const payload = (chosen: 'good' | 'bad') => ({ job, stage, rating: chosen, issues: chosen === 'bad' ? issues : [], person: chosen === 'bad' ? person : null, note: chosen === 'bad' ? note : '' });

  const thumbsUp = async () => {
    setRating('good');
    setError(null);
    setBusy('saving');
    try {
      await save(payload('good'));
      setSaved('Thanks — saved as looking right.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const submit = async (redraw: boolean) => {
    setError(null);
    setSaved(null);
    if (issues.length === 0 && !note.trim()) {
      setError('Tick what was wrong, or write a note.');
      return;
    }
    setBusy(redraw ? 'redrawing' : 'saving');
    const run = ++runRef.current;
    try {
      const id = await save(payload('bad'));
      if (!redraw) {
        setSaved('Saved. The team will see it in the admin panel under Feedback.');
        return;
      }
      setStageNow('inking');
      const result = await runRedraw({
        previousJob: job,
        feedbackId: id,
        category: category as string,
        onStage: (next) => run === runRef.current && setStageNow(next),
        cancelled: () => run !== runRef.current,
      });
      if (!result || run !== runRef.current) return;
      setBefore(image ?? null);
      onRedrawn?.(result);
      // The new drawing can be rated in its turn.
      setRating(null);
      setIssues([]);
      setNote('');
      setSaved('Redrawn with your corrections. Compare it with the one before, and rate the new one.');
    } catch (e) {
      setError(e instanceof SketchError || e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      if (run === runRef.current) setBusy(null);
    }
  };

  const toggle = (key: string) => setIssues((list) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]));
  const chip = (on: boolean) =>
    `rounded-full border px-4 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 ${on ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
      {before && image && (
        <div className="grid grid-cols-2 gap-3">
          {[
            { label: 'Before', src: before },
            { label: 'After your corrections', src: image },
          ].map((view) => (
            <figure key={view.label} className="flex flex-col gap-1">
              {/* eslint-disable-next-line @next/next/no-img-element -- a data URL made in this session */}
              <img src={view.src} alt={view.label} className="aspect-square w-full rounded-lg border border-slate-200 bg-white object-contain" />
              <figcaption className="text-center text-xs text-slate-500">{view.label}</figcaption>
            </figure>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-center gap-2">
        <span className="text-sm text-slate-700">How is {NOUN[stage]}?</span>
        <button type="button" disabled={Boolean(busy)} onClick={thumbsUp} className={chip(rating === 'good')}>
          👍 Looks right
        </button>
        <button
          type="button"
          disabled={Boolean(busy)}
          onClick={() => {
            setRating('bad');
            setSaved(null);
          }}
          className={chip(rating === 'bad')}
        >
          👎 Needs changes
        </button>
      </div>

      {rating === 'bad' && (
        <div className="flex flex-col gap-3 border-t border-slate-200 pt-3">
          <fieldset>
            <legend className="text-sm font-medium text-slate-700">What was wrong?</legend>
            <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
              {ISSUES[stage].map((issue) => (
                <label key={issue.key} className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={issues.includes(issue.key)} onChange={() => toggle(issue.key)} disabled={Boolean(busy)} />
                  {issue.label}
                </label>
              ))}
            </div>
          </fieldset>
          {stage === 'sketch' && category && GROUPS.has(category) && (
            <label className="block text-sm">
              <span className="font-medium text-slate-700">Who is it about?</span>
              <select value={person} onChange={(e) => setPerson(e.target.value as Person)} disabled={Boolean(busy)} className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
                {PEOPLE.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="block text-sm">
            <span className="font-medium text-slate-700">In your own words (optional)</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX))}
              disabled={Boolean(busy)}
              rows={2}
              placeholder={stage === 'sketch' ? 'e.g. the pottu should be a tiny dot, like in the photo' : 'What should be different?'}
              className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={Boolean(busy)} onClick={() => submit(false)} className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
              {busy === 'saving' ? 'Saving…' : 'Save feedback'}
            </button>
            {canRedraw && (
              <button type="button" disabled={Boolean(busy)} onClick={() => submit(true)} className="rounded-full bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50">
                {busy === 'redrawing' ? 'Redrawing…' : 'Save and redraw with these fixes'}
              </button>
            )}
          </div>
          {canRedraw && !busy && <p className="text-xs text-slate-500">A redraw redoes the drawing only: about ₹5 and 2 to 4 minutes. The current sketch is kept until the new one is back.</p>}
        </div>
      )}

      {busy === 'redrawing' && <p className="text-sm text-slate-600">{STAGE_TEXT[stageNow]}</p>}
      {saved && <p className="text-sm text-emerald-700">{saved}</p>}
      {error && (
        <p role="alert" className="text-sm text-rose-600">
          {error}
        </p>
      )}
    </div>
  );
}
