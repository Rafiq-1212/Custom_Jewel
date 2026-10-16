'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** The menu's links, the current screen marked. A design's own page counts as Designs. */
export function NavLinks({ items }: { items: { href: string; label: string }[] }) {
  const path = usePathname();
  return items.map((item) => {
    const active = item.href === '/' ? path === '/' : path === item.href || path.startsWith(`${item.href}/`);
    return (
      <Link
        key={item.href}
        href={item.href}
        aria-current={active ? 'page' : undefined}
        className={`rounded-lg px-3 py-2 text-sm ${active ? 'bg-slate-900 font-medium text-white' : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'}`}
      >
        {item.label}
      </Link>
    );
  });
}
