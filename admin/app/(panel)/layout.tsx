import { NavLinks } from './nav';
import { ROLES, SCREENS, canSee } from '@/lib/access';
import { signOut } from '@/lib/actions';
import { requireAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** Every screen of the panel: the menu down the left, the page beside it. A login sees only the screens it has (lib/access.ts). */
export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const me = await requireAdmin();
  const nav = [
    ...SCREENS.filter((s) => canSee(me, s.key)).map((s) => ({ href: s.href, label: s.label })),
    ...(me.role === 'owner' ? [{ href: '/team', label: 'Team' }] : []),
    { href: '/account', label: 'Account' },
  ];
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col border-b border-slate-200 bg-white md:sticky md:top-0 md:h-screen md:w-56 md:border-b-0 md:border-r">
        <div className="px-5 py-4 text-sm font-semibold text-slate-900">True Tribute — Admin</div>
        <nav className="flex flex-wrap gap-1 px-3 pb-3 md:flex-col">
          <NavLinks items={nav} />
        </nav>
        <div className="mt-auto border-t border-slate-100 px-5 py-4">
          <div className="truncate text-sm font-medium text-slate-900">{me.name}</div>
          <div className="truncate text-xs text-slate-500">
            {me.email} · {ROLES.find((r) => r.value === me.role)?.label}
          </div>
          <form action={signOut}>
            <button type="submit" className="mt-2 text-sm text-slate-700 underline-offset-2 hover:underline">
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 md:px-8">{children}</main>
    </div>
  );
}
