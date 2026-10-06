'use client';

import { useActionState } from 'react';
import { changePassword } from '@/lib/actions';

const input = 'mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-900';

export function PasswordForm() {
  const [state, action, pending] = useActionState(changePassword, { error: null });
  return (
    <form action={action} className="max-w-sm space-y-4 p-4">
      <label className="block">
        <span className="text-sm font-medium text-slate-700">Current password</span>
        <input name="current" type="password" autoComplete="current-password" required className={input} />
      </label>
      <label className="block">
        <span className="text-sm font-medium text-slate-700">New password (10 characters or more)</span>
        <input name="next" type="password" autoComplete="new-password" required minLength={10} className={input} />
      </label>
      {state.error && (
        <p role="alert" className="text-sm text-rose-600">
          {state.error}
        </p>
      )}
      <button type="submit" disabled={pending} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60">
        {pending ? 'One moment…' : 'Change password'}
      </button>
    </form>
  );
}
