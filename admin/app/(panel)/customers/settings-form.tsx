'use client';

import { useActionState } from 'react';
import { saveShopSettings } from '@/lib/actions';

const input = 'mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-900';

/** The support number customers see when their designs run out, and how many designs a new customer gets. */
export function ShopSettingsForm({ supportPhone, triesLimit, editable }: { supportPhone: string; triesLimit: number; editable: boolean }) {
  const [state, action, pending] = useActionState(saveShopSettings, { error: null });
  return (
    <form action={action} className="grid gap-4 p-4 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
      <label className="block">
        <span className="text-sm font-medium text-slate-700">Support number (shown when a customer runs out)</span>
        <input name="supportPhone" defaultValue={supportPhone} placeholder="+91 98765 43210" disabled={!editable} className={input} />
      </label>
      <label className="block">
        <span className="text-sm font-medium text-slate-700">Designs per customer</span>
        <input name="triesLimit" type="number" min={1} max={50} defaultValue={triesLimit} disabled={!editable} className={input} />
      </label>
      {editable && (
        <button type="submit" disabled={pending} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60">
          {pending ? 'Saving…' : 'Save'}
        </button>
      )}
      {state.error && (
        <p role="alert" className="text-sm text-rose-600 sm:col-span-3">
          {state.error}
        </p>
      )}
      {state.saved && !state.error && <p className="text-sm text-emerald-700 sm:col-span-3">Saved.</p>}
      {!supportPhone && !state.saved && <p className="text-sm text-amber-700 sm:col-span-3">No support number yet: customers who run out are only asked to contact the shop.</p>}
    </form>
  );
}
