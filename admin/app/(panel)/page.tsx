import Link from 'next/link';
import { percent, rupees, stepName, when } from '@/lib/format';
import { byDay, recentFailures, spendByStep, toRange, totals } from '@/lib/queries';
import { Card, Empty, PageTitle, RangePicker, Stat, td, th } from '@/lib/ui';

export default async function OverviewPage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const range = toRange((await searchParams).range);
  const [t, days, steps, failures] = await Promise.all([totals(range), byDay(), spendByStep(range), recentFailures()]);
  const attempts = t.tried + t.failedBeforeStart;
  const allFailed = t.failed + t.failedBeforeStart;
  const busiest = Math.max(1, ...days.map((d) => d.spendUsd));

  return (
    <>
      <PageTitle title="Overview" hint="How many pictures were tried, how many came out, and what Gemini charged for them.">
        <RangePicker path="/" range={range} />
      </PageTitle>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Sketches tried" value={String(attempts)} note={`${t.done} finished · ${allFailed} failed · ${t.running} in progress`} />
        <Stat label="Came out" value={percent(t.done, attempts)} note={t.redone ? `${t.redone} had to be drawn twice` : 'of sketches tried'} />
        <Stat label="Product photos" value={String(t.photos)} note={`${t.files} sets of production files`} />
        <Stat label="Spent on Gemini" value={rupees(t.spendUsd)} note={t.done ? `${rupees(t.spendUsd / t.done)} per finished sketch, all steps` : 'no finished sketches yet'} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card title="Last 14 days">
            {days.length === 0 ? (
              <Empty>Nothing has been made in the last 14 days.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className={th}>Day</th>
                      <th className={th}>Sketches</th>
                      <th className={th}>Finished</th>
                      <th className={th}>Failed</th>
                      <th className={th}>Photos</th>
                      <th className={th}>Files</th>
                      <th className={th}>Spent</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {days.map((d) => (
                      <tr key={d.day}>
                        <td className={`${td} whitespace-nowrap font-medium text-slate-900`}>{d.day}</td>
                        <td className={`${td} tabular-nums`}>{d.sketches}</td>
                        <td className={`${td} tabular-nums`}>{d.done}</td>
                        <td className={`${td} tabular-nums ${d.failed ? 'text-rose-600' : ''}`}>{d.failed}</td>
                        <td className={`${td} tabular-nums`}>{d.photos}</td>
                        <td className={`${td} tabular-nums`}>{d.files}</td>
                        <td className={td}>
                          <div className="flex items-center gap-2">
                            <span className="w-20 shrink-0 tabular-nums">{rupees(d.spendUsd)}</span>
                            <span className="h-2 rounded bg-slate-800" style={{ width: `${Math.max(2, (80 * d.spendUsd) / busiest)}px` }} />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="Where the money went">
            {steps.length === 0 ? (
              <Empty>No spending in this period.</Empty>
            ) : (
              <ul className="divide-y divide-slate-100">
                {steps.map((s) => (
                  <li key={s.kind} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                    <span className="text-slate-700">
                      {stepName(s.kind)} <span className="text-slate-400">× {s.count}</span>
                    </span>
                    <span className="tabular-nums font-medium text-slate-900">{rupees(s.spendUsd)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Latest failures">
            {failures.length === 0 ? (
              <Empty>No failed sketches.</Empty>
            ) : (
              <ul className="divide-y divide-slate-100">
                {failures.map((f, i) => (
                  <li key={i} className="px-4 py-2.5 text-sm">
                    <div className="text-xs text-slate-500">{when(f.createdAt)}</div>
                    <div className="break-words text-slate-700">{f.detail ?? 'No reason recorded'}</div>
                    {f.generationId && (
                      <Link href={`/generations/${f.generationId.replace('batches/', '')}`} className="text-xs text-slate-900 underline">
                        Open this generation
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
