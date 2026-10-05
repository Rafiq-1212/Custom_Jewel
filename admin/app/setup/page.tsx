import { redirect } from 'next/navigation';
import { needsSetup, setUp } from '@/lib/actions';
import { AuthForm } from '../login/form';

export const dynamic = 'force-dynamic';

/** Makes the first admin account. Closed for good once one exists. */
export default async function SetupPage() {
  if (!(await needsSetup())) redirect('/login');
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <h1 className="text-xl font-semibold text-slate-900">Set up the admin account</h1>
      <p className="mb-6 mt-1 text-sm text-slate-500">
        This page works once. The setup code is the value of ADMIN_SETUP_CODE in this project&apos;s environment variables on Vercel.
      </p>
      <AuthForm
        action={setUp}
        submit="Create account"
        fields={[
          { name: 'code', label: 'Setup code', type: 'password', autoComplete: 'off' },
          { name: 'name', label: 'Your name', type: 'text', autoComplete: 'name' },
          { name: 'email', label: 'Email', type: 'email', autoComplete: 'username' },
          { name: 'password', label: 'Password (10 characters or more)', type: 'password', autoComplete: 'new-password' },
        ]}
      />
    </main>
  );
}
