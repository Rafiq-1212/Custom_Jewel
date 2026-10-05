/** The few pieces every screen of the panel is built from. */

import Link from 'next/link';
import type { Range } from './queries';

export function PageTitle({ title, hint, children }: { title: string; hint?: string; children?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {hint && <p className="mt-1 text-sm text-slate-500">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

export function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</div>
      {note && <div className="mt-1 text-xs text-slate-500">{note}</div>}
    </div>
  );
}

export function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white">
      {title && <h2 className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-900">{title}</h2>}
      {children}
    </section>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-8 text-center text-sm text-slate-500">{children}</p>;
}

const STATUS_STYLES: Record<string, string> = {
  done: 'bg-emerald-50 text-emerald-700',
  failed: 'bg-rose-50 text-rose-700',
  running: 'bg-amber-50 text-amber-700',
};

export function Status({ status }: { status: string }) {
  const label = status === 'done' ? 'Finished' : status === 'failed' ? 'Failed' : status === 'running' ? 'In progress' : status;
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status] ?? 'bg-slate-100 text-slate-700'}`}>{label}</span>;
}

const RANGES: { value: Range; label: string }[] = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: 'all', label: 'All time' },
];

/** Links that switch the page between the last week, the last month and everything. */
export function RangePicker({ path, range }: { path: string; range: Range }) {
  return (
    <div className="flex rounded-lg border border-slate-200 bg-white p-0.5 text-sm">
      {RANGES.map((r) => (
        <Link
          key={r.value}
          href={`${path}?range=${r.value}`}
          className={`rounded-md px-3 py-1 ${r.value === range ? 'bg-slate-900 text-white' : 'text-slate-600 hover:text-slate-900'}`}
        >
          {r.label}
        </Link>
      ))}
    </div>
  );
}

export const th = 'px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-slate-500';
export const td = 'px-4 py-2.5 text-sm text-slate-700';
