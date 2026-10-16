import Link from 'next/link';
import { canEdit } from '@/lib/access';
import { setFeedbackStatus } from '@/lib/actions';
import { requireScreen } from '@/lib/auth';
import { BASE_PATH } from '@/lib/base-path';
import { PERSON_LABELS, STAGE_LABELS } from '@/lib/feedback-labels';
import { when } from '@/lib/format';
import { feedbackGivers, feedbackList, issueCounts } from '@/lib/queries';
import { Card, Empty, PageTitle } from '@/lib/ui';

type Params = { stage?: string; issue?: string; status?: string; rating?: string; by?: string };

/** A link to this screen with one filter changed (or cleared, with null). */
function filterHref(current: Params, change: Partial<Record<keyof Params, string | null>>): string {
  const next = { ...current, ...change };
  const query = new URLSearchParams(Object.entries(next).filter((entry): entry is [string, string] => Boolean(entry[1])));
  const text = query.toString();
  return text ? `/feedback?${text}` : '/feedback';
}

const chip = (active: boolean) =>
  `rounded-full border px-3 py-1 text-sm ${active ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`;

/** What the team said about what the tool made: the most common problems first, then every piece of feedback. */
export default async function FeedbackPage({ searchParams }: { searchParams: Promise<Params> }) {
  const me = await requireScreen('feedback');
  const params = await searchParams;
  const status = params.status ?? 'open';
  const [items, counts, givers] = await Promise.all([
    feedbackList({ stage: params.stage, issue: params.issue, status: status === 'all' ? null : status, rating: params.rating ?? (status === 'all' ? null : 'bad'), by: params.by }),
    issueCounts(),
    feedbackGivers(),
  ]);
  const editor = canEdit(me);

  return (
    <>
      <PageTitle title="Feedback" hint="What the team said about the sketches, product photos and production files: the most common problems first. Mark one fixed once the tool has been changed for it." />

      <Card title="Most reported problems">
        {counts.length === 0 ? (
          <Empty>No problems reported yet. They appear here when someone presses 👎 in the tool.</Empty>
        ) : (
          <div className="flex flex-wrap gap-2 p-4">
            {counts.map((c) => {
              const active = params.issue === c.issue && params.stage === c.stage;
              return (
                <Link
                  key={`${c.stage}:${c.issue}`}
                  href={filterHref(params, active ? { issue: null, stage: null } : { issue: c.issue, stage: c.stage })}
                  className={`rounded-xl border px-3 py-2 text-sm ${active ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}`}
                >
                  <div className="font-medium">{c.label}</div>
                  <div className={`text-xs ${active ? 'text-slate-300' : 'text-slate-500'}`}>
                    {STAGE_LABELS[c.stage]} · {c.open} open of {c.total} · last {when(c.last)}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
        {params.issue && params.stage && (
          <div className="border-t border-slate-100 px-4 py-3 text-sm">
            <a href={`${BASE_PATH}/api/feedback-export?issue=${encodeURIComponent(params.issue)}&stage=${encodeURIComponent(params.stage)}`} className="font-medium text-slate-900 underline">
              Download the photos, sketches and notes for this problem
            </a>
            <span className="text-slate-500"> — one zip, to look into it and fix it in the tool.</span>
          </div>
        )}
      </Card>

      <div className="my-4 flex flex-wrap items-center gap-2">
        <span className="text-sm text-slate-500">Show</span>
        {[
          { value: 'open', label: 'Open problems' },
          { value: 'fixed', label: 'Fixed' },
          { value: 'all', label: 'Everything, 👍 too' },
        ].map((s) => (
          <Link key={s.value} href={filterHref(params, { status: s.value === 'open' ? null : s.value, rating: null })} className={chip(status === s.value)}>
            {s.label}
          </Link>
        ))}
        <span className="ml-2 text-sm text-slate-500">On</span>
        {['', 'sketch', 'product_photo', 'production_files'].map((stage) => (
          <Link key={stage || 'any'} href={filterHref(params, { stage: stage || null, issue: null })} className={chip((params.stage ?? '') === stage)}>
            {stage ? STAGE_LABELS[stage] : 'Everything'}
          </Link>
        ))}
        {givers.length > 1 && (
          <>
            <span className="ml-2 text-sm text-slate-500">From</span>
            <Link href={filterHref(params, { by: null })} className={chip(!params.by)}>
              Everyone
            </Link>
            {givers.map((g) => (
              <Link key={g.id} href={filterHref(params, { by: g.id })} className={chip(params.by === g.id)}>
                {g.name}
              </Link>
            ))}
          </>
        )}
      </div>

      <div className="space-y-3">
        {items.length === 0 && (
          <Card>
            <Empty>Nothing here.</Empty>
          </Card>
        )}
        {items.map((f) => {
          const design = f.generationId ? `/generations/${f.generationId.replace('batches/', '')}` : null;
          return (
            <section key={f.id} className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-4 sm:flex-row">
              <div className="h-24 w-24 shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-white">
                {f.sketchFile && design ? (
                  <Link href={design}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- served by our own signed-in route, not a public URL */}
                    <img src={`${BASE_PATH}/api/file?path=${encodeURIComponent(f.sketchFile)}&w=160`} alt="Sketch" loading="lazy" className="h-full w-full object-contain" />
                  </Link>
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-slate-400">No sketch</div>
                )}
              </div>
              <div className="min-w-0 flex-1 space-y-1.5 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-lg" aria-label={f.rating === 'good' ? 'Looks right' : 'Needs changes'}>
                    {f.rating === 'good' ? '👍' : '👎'}
                  </span>
                  <span className="font-medium text-slate-900">{STAGE_LABELS[f.stage] ?? f.stage}</span>
                  {f.category && <span className="capitalize text-slate-500">{f.category}</span>}
                  <span className="text-slate-500">
                    · {f.by ?? 'Unknown'} · {when(f.createdAt)}
                  </span>
                  {f.rating === 'bad' && (
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${f.status === 'fixed' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
                      {f.status === 'fixed' ? 'Fixed' : 'Open'}
                    </span>
                  )}
                </div>
                {f.issueLabels.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {f.issueLabels.map((label) => (
                      <span key={label} className="rounded-full bg-rose-50 px-2 py-0.5 text-xs text-rose-700">
                        {label}
                      </span>
                    ))}
                  </div>
                )}
                {f.person && f.person !== 'all' && <div className="text-slate-600">About: {PERSON_LABELS[f.person] ?? f.person}</div>}
                {f.note && <blockquote className="border-l-2 border-slate-200 pl-3 text-slate-700">{f.note}</blockquote>}
                <div className="flex flex-wrap gap-3 text-xs">
                  {design && (
                    <Link href={design} className="text-slate-900 underline">
                      Open the design
                    </Link>
                  )}
                  {f.redrawJob && (
                    <Link href={`/generations/${f.redrawJob.replace('batches/', '')}`} className="text-slate-900 underline">
                      See the redraw made from this
                    </Link>
                  )}
                </div>
                {f.status === 'fixed' && (
                  <div className="text-xs text-emerald-700">
                    Fixed {when(f.resolvedAt)}
                    {f.resolvedBy ? ` by ${f.resolvedBy}` : ''}
                    {f.resolution ? `: ${f.resolution}` : ''}
                  </div>
                )}
              </div>
              {editor && f.rating === 'bad' && (
                <form action={setFeedbackStatus} className="flex shrink-0 flex-col gap-2 sm:w-56">
                  <input type="hidden" name="id" value={f.id} />
                  {f.status === 'open' ? (
                    <>
                      <input name="resolution" placeholder="What was changed (optional)" maxLength={400} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
                      <button type="submit" name="status" value="fixed" className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800">
                        Mark fixed
                      </button>
                    </>
                  ) : (
                    <button type="submit" name="status" value="open" className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900 hover:bg-slate-50">
                      Open again
                    </button>
                  )}
                </form>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}
