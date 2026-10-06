import { requireAdmin } from '@/lib/auth';
import { Card, PageTitle } from '@/lib/ui';
import { PasswordForm } from './form';

export default async function AccountPage() {
  const admin = await requireAdmin();
  return (
    <>
      <PageTitle title="Account" hint={`Signed in as ${admin.email}`} />
      <Card title="Change password">
        <p className="px-4 pt-4 text-sm text-slate-500">Changing it signs you out everywhere. You then sign in again with the new password.</p>
        <PasswordForm />
      </Card>
    </>
  );
}
