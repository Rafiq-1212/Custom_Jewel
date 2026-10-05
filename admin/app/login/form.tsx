'use client';

import { useActionState } from 'react';
import type { FormState } from '@/lib/actions';

interface Field {
  name: string;
  label: string;
  type: string;
  autoComplete: string;
}

/** A small form posted to a server action, with its error shown underneath. Used by sign-in and setup. */
export function AuthForm({
  action,
  fields,
  submit,
}: {
  action: (previous: FormState, form: FormData) => Promise<FormState>;
  fields: Field[];
  submit: string;
}) {
  const [state, formAction, pending] = useActionState(action, { error: null });
  return (
    <form action={formAction} className="space-y-4">
      {fields.map((f) => (
        <label key={f.name} className="block">
          <span className="text-sm font-medium text-slate-700">{f.label}</span>
          <input
            name={f.name}
            type={f.type}
            autoComplete={f.autoComplete}
            required
            className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-900"
          />
        </label>
      ))}
      {state.error && (
        <p role="alert" className="text-sm text-rose-600">
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60"
      >
        {pending ? 'One moment…' : submit}
      </button>
    </form>
  );
}
