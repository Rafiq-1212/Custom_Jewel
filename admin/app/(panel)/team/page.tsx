import Link from 'next/link';
import { ROLES, toRole, toScreens } from '@/lib/access';
import { requireOwner } from '@/lib/auth';
import { when } from '@/lib/format';
import { teamMembers } from '@/lib/queries';
import { Card, PageTitle } from '@/lib/ui';
import { CreateMemberForm, MemberForms } from './forms';

/** Owners only: who has a login, what they may see and do, and making new ones. */
export default async function TeamPage() {
  const me = await requireOwner();
  const members = await teamMembers();
  return (
    <>
      <PageTitle title="Team" hint="Everyone with a login, what they can see and do. New logins get a temporary password and choose their own at the first sign-in." />

      <Card title="Add someone">
        <CreateMemberForm />
      </Card>

      <div className="mt-6 space-y-4">
        {members.map((m) => {
          const role = toRole(m.role);
          return (
            <Card key={m.id}>
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
                <div className="min-w-0">
                  <div className="font-medium text-slate-900">
                    {m.name} {m.id === me.id && <span className="text-xs font-normal text-slate-500">(you)</span>}
                  </div>
                  <div className="truncate text-sm text-slate-500">{m.email}</div>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-700">{ROLES.find((r) => r.value === role)?.label}</span>
                  {m.mustChangePassword && <span className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-700">Has not set a password yet</span>}
                  <span className="text-slate-500">Last active {when(m.lastSeenAt)}</span>
                  <Link href={`/generations?by=${m.id}`} className="text-slate-900 underline">
                    What they made
                  </Link>
                </div>
              </div>
              <div className="p-4">
                <MemberForms id={m.id} role={role} screens={toScreens(m.screens)} self={m.id === me.id} />
              </div>
            </Card>
          );
        })}
      </div>
    </>
  );
}
