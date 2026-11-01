'use client';

import Link from 'next/link';
import { useState } from 'react';

/**
 * Makes the design again from the photo it was uploaded with. The pendant
 * tool (app/api/sketch, action=remake) starts it and saves it when it is
 * drawn, a few minutes later; a customer's finds it under "Your designs".
 */
export function RemakeButton({ job, category, forCustomer, compact = false }: { job: string; category: string; forCustomer: boolean; compact?: boolean }) {
  const [state, setState] = useState<{ pending?: boolean; error?: string; started?: string }>({});

  async function remake() {
    setState({ pending: true });
    const body = new FormData();
    body.set('action', 'remake');
    body.set('category', category);
    body.set('from', job);
    const response = await fetch('/api/sketch', { method: 'POST', body }).catch(() => null);
    const json = (await response?.json().catch(() => null)) as { success?: boolean; job?: string; error?: string } | null;
    if (!response?.ok || !json?.success || !json.job) setState({ error: json?.error ?? 'It could not be started. Please try again.' });
    else setState({ started: json.job });
  }

  if (state.started) {
    if (compact) {
      return (
        <Link href={`/generations/${state.started.replace('batches/', '')}`} className="whitespace-nowrap text-xs text-emerald-700 underline">
          Started, open it
        </Link>
      );
    }
    return (
      <p className="text-sm text-emerald-700">
        Started. It is drawn and saved in about 3 to 5 minutes{forCustomer ? ', and the customer finds it under “Your designs”' : ''}.{' '}
        <Link href={`/generations/${state.started.replace('batches/', '')}`} className="underline">
          Open the new design
        </Link>
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={remake}
        disabled={state.pending}
        className={`rounded-lg bg-slate-900 font-medium text-white hover:bg-slate-800 disabled:opacity-60 ${compact ? 'whitespace-nowrap px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm'}`}
      >
        {state.pending ? 'Starting…' : compact ? 'Generate again' : 'Generate from the uploaded photo'}
      </button>
      {state.error && (
        <p role="alert" className={compact ? 'text-xs text-rose-600' : 'text-sm text-rose-600'}>
          {state.error}
        </p>
      )}
    </div>
  );
}
