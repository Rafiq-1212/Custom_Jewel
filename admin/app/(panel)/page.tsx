import Link from 'next/link';
import { ROLES, canSee } from '@/lib/access';
import { requireScreen } from '@/lib/auth';
import { BASE_PATH } from '@/lib/base-path';
import { percent, rupees, stepName, when } from '@/lib/format';
import { activityByMember, byDay, generations, recentFailures, spendByStep, toRange, totals } from '@/lib/queries';
import { Card, Empty, PageTitle, RangePicker, Stat, Status, td, th } from '@/lib/ui';

/** The dashboard: what has been made, by whom, and what it cost. */
export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const me = await requireScreen('overview');
  const range = toRange((await searchParams).range);
  const [t, days, steps, failures, members, latest] = await Promise.all([
    totals(range),
    byDay(),
    spendByStep(range),
    recentFailures(),
    activityByMember(range),
    generations(8),
  ]);
  const seeDesigns = canSee(me, 'designs');
  const attempts = t.tried + t.failedBeforeStart;
  const allFailed = t.failed + t.failedBeforeStart;
  const busiest = Math.max(1, ...days.map((d) => d.spendUsd));

  return (
    <>
      <PageTitle title="Dashboard" hint="What has been made, by whom, how much of it came out, and what Gemini charged for it.">
        <RangePicker path="/" range={range} />
      </PageTitle>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Sketches tried" value={String(attempts)} note={`${t.done} finished · ${allFailed} failed · ${t.running} in progress${t.abandoned ? ` · ${t.abandoned} abandoned` : ''}`} />
        <Stat label="Came out" value={percent(t.done, attempts)} note={t.redone ? `${t.redone} had to be drawn twice` : 'of sketches tried'} />
        <Stat label="Product photos" value={String(t.photos)} note={`${t.files} sets of production files`} />
        <Stat label="Spent on Gemini" value={rupees(t.spendUsd)} note={t.done ? `${rupees(t.spendUsd / t.done)} per finished sketch, all steps` : 'no finished sketches yet'} />
      </div>

      <div className="mt-6">
        <Card title="Latest designs">
          {latest.length === 0 ? (
            <Empty>Nothing has been made yet.</Empty>
          ) : (
            <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4 xl:grid-cols-8">
              {latest.map((g) => {
                const picture = g.sketchFile ? (
                  // eslint-disable-next-line @next/next/no-img-element -- served by our own signed-in route, not a public URL
                  <img src={`${BASE_PATH}/api/file?path=${encodeURIComponent(g.sketchFile)}&w=160`} alt="Sketch" loading="lazy" className="aspect-square w-full object-contain" />
                ) : (
                  <div className="flex aspect-square w-full items-center justify-center text-xs text-slate-400">No sketch</div>
                );
                return (
                  <figure key={g.id} className="min-w-0">
                    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                      {seeDesigns ? <Link href={`/generations/${g.id.replace('batches/', '')}`}>{picture}</Link> : picture}
                    </div>
                    <figcaption className="mt-1.5 space-y-0.5 text-xs">
                      <div className="truncate font-medium text-slate-900">{g.madeBy ?? 'Before team logins'}</div>
                      <div className="truncate capitalize text-slate-500">
                        {g.category} · {when(g.createdAt)}
                      </div>
                      <Status status={g.status} />
                    </figcaption>
                  </figure>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      <div className="mt-6">
        <Card title="By team member">
          {members.length === 0 ? (
            <Empty>Nobody has made anything in this period.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className={th}>Who</th>
                    <th className={th}>Designs</th>
                    <th className={th}>Finished</th>
                    <th className={th}>Product photos</th>
                    <th className={th}>Production files</th>
                    <th className={th}>Spent</th>
                    <th className={th}>Last active</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {members.map((m) => (
                    <tr key={m.id ?? 'before'}>
                      <td className={td}>
                        {m.id && seeDesigns ? (
                          <Link href={`/generations?by=${m.id}`} className="font-medium text-slate-900 underline-offset-2 hover:underline">
                            {m.name}
                          </Link>
                        ) : (
                          <span className={m.id ? 'font-medium text-slate-900' : 'text-slate-500'}>{m.name}</span>
                        )}
                        {m.role && <span className="ml-2 text-xs text-slate-400">{ROLES.find((r) => r.value === m.role)?.label ?? 'Removed'}</span>}
                      </td>
                      <td className={`${td} tabular-nums`}>{m.designs}</td>
                      <td className={`${td} tabular-nums`}>{m.finished}</td>
                      <td className={`${td} tabular-nums`}>{m.photos}</td>
                      <td className={`${td} tabular-nums`}>{m.files}</td>
                      <td className={`${td} tabular-nums font-medium text-slate-900`}>{rupees(m.spendUsd)}</td>
                      <td className={`${td} whitespace-nowrap`}>{when(m.lastAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
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
                    {f.generationId && seeDesigns && (
                      <Link href={`/generations/${f.generationId.replace('batches/', '')}`} className="text-xs text-slate-900 underline">
                        Open this design
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
