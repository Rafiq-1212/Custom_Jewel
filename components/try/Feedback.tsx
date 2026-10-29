'use client';

/**
 * A shop customer's 👍 or 👎 on their pendant, with what they would change.
 * Saved against the design (app/api/feedback) and read by the team in the
 * admin panel's Feedback screen. Unlike the team's (components/FeedbackPanel),
 * it never redraws anything.
 */

import * as React from 'react';
import { authHeaders } from '@/lib/api-auth';
import { NOTE_MAX } from '@/lib/feedback';

export function Feedback({ job, stage }: { job: string; stage: 'sketch' | 'product_photo' }) {
  const [rating, setRating] = React.useState<'good' | 'bad' | null>(null);
  const [note, setNote] = React.useState('');
  const [state, setState] = React.useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');

  const send = async (chosen: 'good' | 'bad') => {
    setState('saving');
    const response = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ job, stage, rating: chosen, issues: chosen === 'bad' && !note.trim() ? ['other'] : [], note: chosen === 'bad' ? note : '' }),
    }).catch(() => null);
    setState(response?.ok ? 'saved' : 'failed');
  };

  if (state === 'saved') return <p className="text-center text-sm text-emerald-700">Thank you! Our team will see this.</p>;

  const chip = (on: boolean) => `rounded-full border px-4 py-1.5 text-sm ${on ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 text-slate-700 hover:bg-slate-50'}`;
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-slate-50 p-3">
      <div className="flex flex-wrap items-center justify-center gap-2">
        <span className="text-sm text-slate-700">How does it look?</span>
        <button
          type="button"
          disabled={state === 'saving'}
          onClick={() => {
            setRating('good');
            void send('good');
          }}
          className={chip(rating === 'good')}
        >
          👍 Love it
        </button>
        <button type="button" disabled={state === 'saving'} onClick={() => setRating('bad')} className={chip(rating === 'bad')}>
          👎 Not quite
        </button>
      </div>
      {rating === 'bad' && (
        <>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX))}
            rows={2}
            placeholder="What would you like changed? (optional)"
            className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          />
          <button type="button" disabled={state === 'saving'} onClick={() => void send('bad')} className="self-end rounded-full bg-slate-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50">
            {state === 'saving' ? 'Sending…' : 'Send'}
          </button>
        </>
      )}
      {state === 'failed' && <p className="text-center text-xs text-rose-600">That didn&apos;t send. Please try again.</p>}
    </div>
  );
}
