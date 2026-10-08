import Link from 'next/link';
import { notFound } from 'next/navigation';
import { list } from '@vercel/blob';
import { rupees, stepName, when } from '@/lib/format';
import { generation } from '@/lib/queries';
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
  const { id } = await params;
  const found = await generation(`batches/${id}`);
  if (!found) notFound();
  const { generation: g, steps } = found;
  const folders = [...new Set([g.folder, ...steps.map((s) => (s.file ? s.file.slice(0, s.file.lastIndexOf('/')) : null))].filter((f): f is string => Boolean(f)))];
  const files = await savedFiles(folders);
  const pictures = files.filter((f) => isPicture(f.name));
  const downloads = files.filter((f) => !isPicture(f.name));
  const total = steps.reduce((sum, s) => sum + s.costUsd, 0);

  return (
    <>
      <PageTitle title={`${g.category[0].toUpperCase()}${g.category.slice(1)} pendant`} hint={`Started ${when(g.createdAt)}`}>
        <Link href="/generations" className="text-sm text-slate-700 underline">
          All generations
        </Link>
      </PageTitle>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Status</div>
          <div className="mt-2">
            <Status status={g.status} />
          </div>
          {g.error && <div className="mt-2 break-words text-xs text-rose-600">{g.error}</div>}
        </div>
        <Stat label="Customer" value={g.phone ?? 'Shop staff'} />
        <Stat label="Total cost" value={rupees(total)} note={`${steps.length} steps`} />
        <Stat label="Finished" value={g.finishedAt ? when(g.finishedAt) : '—'} />
      </div>

      <div className="mt-6">
        <Card title="From photo to pendant">
          {pictures.length === 0 ? (
            <Empty>No pictures were saved for this generation.</Empty>
          ) : (
            <div className="grid grid-cols-2 gap-4 p-4 md:grid-cols-4">
              {pictures.map((f) => (
                <figure key={f.path}>
                  <a href={`/api/file?path=${encodeURIComponent(f.path)}`} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border border-slate-200 bg-white">
                    {/* eslint-disable-next-line @next/next/no-img-element -- served by our own signed-in route, not a public URL */}
                    <img src={`/api/file?path=${encodeURIComponent(f.path)}`} alt={caption(f.name)} loading="lazy" className="aspect-square w-full object-contain" />
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
                  <a href={`/api/file?path=${encodeURIComponent(f.path)}`} className="font-medium text-slate-900 underline">
                    Download
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-6">
        <Card title="Every step, and what it cost">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className={th}>When</th>
                  <th className={th}>Step</th>
                  <th className={th}>Detail</th>
                  <th className={th}>Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {steps.map((s) => (
                  <tr key={s.id}>
                    <td className={`${td} whitespace-nowrap`}>{when(s.createdAt)}</td>
                    <td className={`${td} font-medium text-slate-900`}>{stepName(s.kind)}</td>
                    <td className={`${td} break-words`}>{s.detail ?? '—'}</td>
                    <td className={`${td} tabular-nums`}>{rupees(s.costUsd)}</td>
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
