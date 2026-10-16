'use client';

import { useActionState, useState } from 'react';
import { ROLES, SCREENS, type Role } from '@/lib/access';
import { createMember, removeMember, resetMemberPassword, updateMember, type TeamState } from '@/lib/team';

const input = 'mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-900';
const button = 'rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50';
const empty: TeamState = { error: null };

function Message({ state, saved }: { state: TeamState; saved?: string }) {
  if (state.error)
    return (
      <p role="alert" className="text-sm text-rose-600">
        {state.error}
      </p>
    );
  if (state.issued)
    return (
      <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        <div>
          Temporary password for <strong>{state.issued.email}</strong>:
        </div>
        <div className="mt-1 select-all font-mono text-base font-semibold tracking-wide">{state.issued.password}</div>
        <div className="mt-1 text-xs">Copy it now and pass it on: it is not shown again. They choose their own password when they first sign in.</div>
      </div>
    );
  return saved ? <p className="text-sm text-emerald-700">{saved}</p> : null;
}

/** Role, and for editors and viewers the screens they see. Viewers are never offered the pendant tool. */
function Access({ role, screens, onRole }: { role: Role; screens: string[]; onRole: (role: Role) => void }) {
  return (
    <div className="space-y-3">
      <label className="block">
        <span className="text-sm font-medium text-slate-700">Role</span>
        <select name="role" value={role} onChange={(e) => onRole(e.target.value as Role)} className={input}>
          {ROLES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label} — {r.hint}
            </option>
          ))}
        </select>
      </label>
      <fieldset>
        <legend className="text-sm font-medium text-slate-700">Screens they see</legend>
        {role === 'owner' ? (
          <p className="mt-1 text-sm text-slate-500">Owners see every screen, and Team.</p>
        ) : (
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {SCREENS.map((s) => {
              const off = role === 'viewer' && s.key === 'generate';
              return (
                <label key={s.key} className={`flex items-center gap-2 text-sm ${off ? 'text-slate-400' : 'text-slate-700'}`}>
                  <input type="checkbox" name="screens" value={s.key} defaultChecked={!off && screens.includes(s.key)} disabled={off} />
                  {s.label}
                  {off && <span className="text-xs">(editors only)</span>}
                </label>
              );
            })}
          </div>
        )}
      </fieldset>
    </div>
  );
}

export function CreateMemberForm() {
  const [state, action, pending] = useActionState(createMember, empty);
  const [role, setRole] = useState<Role>('editor');
  return (
    <form action={action} className="space-y-4 p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Name</span>
          <input name="name" required autoComplete="off" className={input} />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Email (they sign in with it)</span>
          <input name="email" type="email" required autoComplete="off" className={input} />
        </label>
      </div>
      <Access role={role} screens={['generate', 'designs']} onRole={setRole} />
      <Message state={state} />
      <button type="submit" disabled={pending} className={`${button} bg-slate-900 text-white hover:bg-slate-800`}>
        {pending ? 'Making the login…' : 'Create login with a temporary password'}
      </button>
    </form>
  );
}

export function MemberForms({ id, role, screens, self }: { id: string; role: Role; screens: string[]; self: boolean }) {
  const [saveState, save, saving] = useActionState(updateMember, empty);
  const [resetState, reset, resetting] = useActionState(resetMemberPassword, empty);
  const [removeState, remove, removing] = useActionState(removeMember, empty);
  const [current, setCurrent] = useState<Role>(role);
  return (
    <div className="space-y-4">
      <form action={save} className="space-y-3">
        <input type="hidden" name="id" value={id} />
        <Access role={current} screens={screens} onRole={setCurrent} />
        <Message state={saveState} saved={saving ? undefined : saveState === empty ? undefined : 'Saved.'} />
        <button type="submit" disabled={saving} className={`${button} border border-slate-300 bg-white text-slate-900 hover:bg-slate-50`}>
          {saving ? 'Saving…' : 'Save access'}
        </button>
      </form>
      {!self && (
        <div className="flex flex-wrap items-start gap-3 border-t border-slate-100 pt-3">
          <form action={reset}>
            <input type="hidden" name="id" value={id} />
            <button type="submit" disabled={resetting} className={`${button} border border-slate-300 bg-white text-slate-900 hover:bg-slate-50`}>
              {resetting ? 'One moment…' : 'Reset password'}
            </button>
          </form>
          <form
            action={remove}
            onSubmit={(e) => {
              if (!confirm('Remove this login? They will be signed out and cannot sign in again. What they made stays, under their name.')) e.preventDefault();
            }}
          >
            <input type="hidden" name="id" value={id} />
            <button type="submit" disabled={removing} className={`${button} border border-rose-200 bg-white text-rose-700 hover:bg-rose-50`}>
              {removing ? 'Removing…' : 'Remove login'}
            </button>
          </form>
          <div className="w-full space-y-2">
            <Message state={resetState} />
            <Message state={removeState} />
          </div>
        </div>
      )}
    </div>
  );
}
