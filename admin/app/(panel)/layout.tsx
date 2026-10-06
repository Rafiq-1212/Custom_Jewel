import Link from 'next/link';
import { signOut } from '@/lib/actions';
import { requireAdmin } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const NAV = [
  { href: '/', label: 'Overview' },
  { href: '/generations', label: 'Generations' },
  { href: '/generate', label: 'Create a pendant' },
  { href: '/customers', label: 'Customers and tries' },
  { href: '/revenue', label: 'Revenue' },
  { href: '/account', label: 'Account' },
];

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdmin();
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col border-b border-slate-200 bg-white md:w-56 md:border-b-0 md:border-r">
        <div className="px-5 py-4 text-sm font-semibold text-slate-900">True Tribute — Admin</div>
        <nav className="flex flex-wrap gap-1 px-3 pb-3 md:flex-col">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="rounded-lg px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 hover:text-slate-900">
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto border-t border-slate-100 px-5 py-4">
          <Link href="/account" className="block truncate text-xs text-slate-500 underline-offset-2 hover:underline">
            {admin.email}
          </Link>
          <form action={signOut}>
            <button type="submit" className="mt-1 text-sm text-slate-700 underline-offset-2 hover:underline">
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 md:px-8">{children}</main>
    </div>
  );
}
