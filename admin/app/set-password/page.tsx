import { redirect } from 'next/navigation';
import { homeOf } from '@/lib/access';
import { setFirstPassword, signOut } from '@/lib/actions';
import { requireAdmin } from '@/lib/auth';
import { AuthForm } from '../login/form';

export const dynamic = 'force-dynamic';

/** A new login's first stop: nothing else in the panel opens until it has replaced its temporary password. */
export default async function SetPasswordPage() {
  const me = await requireAdmin({ passwordChange: true });
  if (!me.mustChangePassword) redirect(homeOf(me));
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <h1 className="text-xl font-semibold text-slate-900">Welcome, {me.name}</h1>
      <p className="mb-6 mt-1 text-sm text-slate-500">You signed in with a temporary password. Choose your own to carry on; you will use it from now on.</p>
      <AuthForm
        action={setFirstPassword}
        submit="Save my password"
        fields={[
          { name: 'current', label: 'Temporary password', type: 'password', autoComplete: 'current-password' },
          { name: 'next', label: 'New password (10 characters or more)', type: 'password', autoComplete: 'new-password' },
          { name: 'again', label: 'New password again', type: 'password', autoComplete: 'new-password' },
        ]}
      />
      <form action={signOut} className="mt-4 text-center">
        <button type="submit" className="text-sm text-slate-500 underline-offset-2 hover:underline">
          Not you? Sign out
        </button>
      </form>
    </main>
  );
}
