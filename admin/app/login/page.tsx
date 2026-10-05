import { redirect } from 'next/navigation';
import { needsSetup, signIn } from '@/lib/actions';
import { AuthForm } from './form';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  if (await needsSetup()) redirect('/setup');
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <h1 className="text-xl font-semibold text-slate-900">True Tribute — Admin</h1>
      <p className="mb-6 mt-1 text-sm text-slate-500">Sign in to see what has been made and what it cost.</p>
      <AuthForm
        action={signIn}
        submit="Sign in"
        fields={[
          { name: 'email', label: 'Email', type: 'email', autoComplete: 'username' },
          { name: 'password', label: 'Password', type: 'password', autoComplete: 'current-password' },
        ]}
      />
    </main>
  );
}
