import Link from 'next/link';
import { BASE_PATH } from '@/lib/base-path';
import { notFound } from 'next/navigation';
import { list } from '@vercel/blob';
import { requireScreen } from '@/lib/auth';
import { stepName, when } from '@/lib/format';
import { PERSON_LABELS, STAGE_LABELS } from '@/lib/feedback-labels';
import { feedbackOnDesign, generation, redrawsOf } from '@/lib/queries';
import { ordersOf } from '@/lib/shop-queries';
import { Card, Empty, PageTitle, Stat, Status, td, th } from '@/lib/ui';

interface Saved {
  path: string;
  name: string;
  size: number;
}

/** Everything saved for this order: its own folder, and any later day's folder a product photo went to. */
async function savedFiles(folders: string[]): Promise<Saved[]> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return [];
  const found = await Promise.all(folders.map((folder) => list({ prefix: `${folder}/` }).catch(() => ({ blobs: [] }))));
  return found
    .flatMap((result) => result.blobs)
    .map((blob) => ({ path: blob.pathname, name: blob.pathname.slice(blob.pathname.lastIndexOf('/') + 1), size: blob.size }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function size(bytes: number): string {
  return bytes > 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

const isPicture = (name: string) => /\.(png|jpe?g|webp)$/i.test(name);

function caption(name: string): string {
  if (name.includes('photo.')) return 'Customer\'s photo';
  if (name.includes('sketch')) return 'Sketch';
  if (name.includes('product-gold')) return 'Product photo, gold';
  if (name.includes('product-silver')) return 'Product photo, silver';
  if (name.includes('production-files')) return 'Production files (DXF, SVG, PNG)';
  return name;
}

export default async function GenerationPage({ params }: { params: Promise<{ id: string }> }) {
  await requireScreen('designs');
  const { id } = await params;
  const found = await generation(`batches/${id}`);
  if (!found) notFound();
  const { generation: g, steps } = found;
  const folders = [...new Set([g.folder, ...steps.map((s) => (s.file ? s.file.slice(0, s.file.lastIndexOf('/')) : null))].filter((f): f is string => Boolean(f)))];
  const [files, feedback, redraws, orders] = await Promise.all([savedFiles(folders), feedbackOnDesign(g.id), redrawsOf(g.id), ordersOf(g.id)]);
  const pictures = files.filter((f) => isPicture(f.name));
  const downloads = files.filter((f) => !isPicture(f.name));

  return (
    <>
      <Link
        href={g.madeById ? `/generations?by=${g.madeById}` : '/generations'}
        className="mb-4 inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
      >
        <span aria-hidden>←</span> Back to designs
      </Link>
      <PageTitle title={`${g.category[0].toUpperCase()}${g.category.slice(1)} pendant`} hint={`Started ${when(g.createdAt)}`} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Status</div>
          <div className="mt-2">
            <Status status={g.status} />
          </div>
          {g.error && <div className="mt-2 break-words text-xs text-rose-600">{g.error}</div>}
        </div>
        <Stat label="Made by" value={g.madeBy ?? 'Before team logins'} note={g.phone && g.madeById ? `for ${g.phone}` : undefined} />
        <Stat label="Steps" value={String(steps.length)} />
        <Stat label="Finished" value={g.finishedAt ? when(g.finishedAt) : '—'} />
      </div>

      {orders.length > 0 && (
        <div className="mt-6">
          <Card title="Bought on the shop">
            <ul className="divide-y divide-slate-100">
              {orders.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                  <span className="font-medium text-slate-900">
                    {o.orderName ?? o.id} · {o.product ?? 'Pendant'}
                    {o.variant ? ` · ${o.variant}` : ''}
                  </span>
                  <span className="text-slate-500">
                    {o.phone ?? ''} · {when(o.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      {(g.parentId || redraws.length > 0) && (
        <div className="mt-6">
          <Card title="Redraws">
            <div className="space-y-2 p-4 text-sm">
              {g.parentId && (
                <div>
                  This is a redraw of{' '}
                  <Link href={`/generations/${g.parentId.replace('batches/', '')}`} className="font-medium text-slate-900 underline">
                    an earlier drawing
                  </Link>
                  , with these corrections from the shop:
                  {g.corrections && <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 font-sans text-xs text-slate-700">{g.corrections}</pre>}
                </div>
              )}
              {redraws.map((r) => (
                <div key={r.id}>
                  Redrawn from feedback on {when(r.createdAt)}:{' '}
                  <Link href={`/generations/${r.id.replace('batches/', '')}`} className="font-medium text-slate-900 underline">
                    open the redraw
                  </Link>{' '}
                  <Status status={r.status} />
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      <div className="mt-6">
        <Card title="Feedback">
          {feedback.length === 0 ? (
            <Empty>No feedback on this design yet.</Empty>
          ) : (
            <ul className="divide-y divide-slate-100">
              {feedback.map((f) => (
                <li key={f.id} className="space-y-1 px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span>{f.rating === 'good' ? '👍' : '👎'}</span>
                    <span className="font-medium text-slate-900">{STAGE_LABELS[f.stage] ?? f.stage}</span>
                    <span className="text-slate-500">
                      · {f.by ?? 'Unknown'} · {when(f.createdAt)}
                    </span>
                    {f.rating === 'bad' && (
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${f.status === 'fixed' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
                        {f.status === 'fixed' ? 'Fixed' : 'Open'}
                      </span>
                    )}
                  </div>
                  {f.issueLabels.length > 0 && <div className="text-slate-700">{f.issueLabels.join(' · ')}</div>}
                  {f.person && f.person !== 'all' && <div className="text-slate-500">About: {PERSON_LABELS[f.person] ?? f.person}</div>}
                  {f.note && <blockquote className="border-l-2 border-slate-200 pl-3 text-slate-700">{f.note}</blockquote>}
                  {f.redrawJob && (
                    <Link href={`/generations/${f.redrawJob.replace('batches/', '')}`} className="text-xs text-slate-900 underline">
                      Redrawn from this feedback
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-6">
        <Card title="From photo to pendant">
          {pictures.length === 0 ? (
            <Empty>No pictures were saved for this generation.</Empty>
          ) : (
            <div className="grid grid-cols-2 gap-4 p-4 md:grid-cols-4">
              {pictures.map((f) => (
                <figure key={f.path}>
                  <a href={`${BASE_PATH}/api/file?path=${encodeURIComponent(f.path)}`} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border border-slate-200 bg-white">
                    {/* eslint-disable-next-line @next/next/no-img-element -- served by our own signed-in route, not a public URL */}
                    <img src={`${BASE_PATH}/api/file?path=${encodeURIComponent(f.path)}&w=480`} alt={caption(f.name)} loading="lazy" className="aspect-square w-full object-contain" />
                  </a>
                  <figcaption className="mt-1.5 text-xs text-slate-600">
                    {caption(f.name)} <span className="text-slate-400">· {size(f.size)}</span>
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
          {downloads.length > 0 && (
            <ul className="border-t border-slate-100">
              {downloads.map((f) => (
                <li key={f.path} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                  <span className="text-slate-700">
                    {caption(f.name)} <span className="text-slate-400">· {size(f.size)}</span>
                  </span>
                  <a href={`${BASE_PATH}/api/file?path=${encodeURIComponent(f.path)}`} className="font-medium text-slate-900 underline">
                    Download
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-6">
        <Card title="Every step">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className={th}>When</th>
                  <th className={th}>Step</th>
                  <th className={th}>By</th>
                  <th className={th}>Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {steps.map((s) => (
                  <tr key={s.id}>
                    <td className={`${td} whitespace-nowrap`}>{when(s.createdAt)}</td>
                    <td className={`${td} font-medium text-slate-900`}>{stepName(s.kind)}</td>
                    <td className={`${td} whitespace-nowrap`}>{s.by ?? '—'}</td>
                    <td className={`${td} break-words`}>{s.detail ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  );
}
