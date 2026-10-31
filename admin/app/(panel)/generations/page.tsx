import Link from 'next/link';
import { BASE_PATH } from '@/lib/base-path';
import { requireScreen } from '@/lib/auth';
import { when } from '@/lib/format';
import { generations, makers } from '@/lib/queries';
import { Card, Empty, PageTitle, Status, td, th } from '@/lib/ui';

const ABANDONED = new Set(['abandoned', 'left_before_photo']);

export default async function DesignsPage({ searchParams }: { searchParams: Promise<{ by?: string; phone?: string; status?: string }> }) {
  await requireScreen('designs');
  const params = await searchParams;
  const by = params.by || null;
  const phone = params.phone || null;
  const abandonedOnly = params.status === 'abandoned';
  const [all, people] = await Promise.all([generations(200, by, phone), makers()]);
  const rows = abandonedOnly ? all.filter((g) => ABANDONED.has(g.status)) : all;
  const chip = (active: boolean) =>
    `rounded-full border px-3 py-1 text-sm ${active ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`;
  return (
    <>
      <PageTitle title="Designs" hint="Every design, newest first: the pendant photo that was made, and who made it — a team member or a shop customer by their number. Abandoned ones show whether they were left while drawing or before the pendant photo." />
      {people.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-sm text-slate-500">Made by</span>
          <Link href="/generations" className={chip(!by && !phone && !abandonedOnly)}>
            Everyone
          </Link>
          <Link href="/generations?status=abandoned" className={chip(abandonedOnly)}>
            Abandoned
          </Link>
          {phone && <span className={chip(true)}>Customer {phone}</span>}
          {people.map((p) => (
            <Link key={p.id} href={`/generations?by=${p.id}`} className={chip(by === p.id)}>
              {p.name}
            </Link>
          ))}
        </div>
      )}
      <Card>
        {rows.length === 0 ? (
          <Empty>{abandonedOnly ? 'Nothing abandoned among the latest designs.' : by ? 'Nothing made by this person yet.' : 'Nothing has been made since tracking was switched on.'}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className={th}>Pendant photo</th>
                  <th className={th}>Sketch</th>
                  <th className={th}>Started</th>
                  <th className={th}>Style</th>
                  <th className={th}>Made by</th>
                  <th className={th}>Customer</th>
                  <th className={th}>Status</th>
                  <th className={th}>Feedback</th>
                  <th className={th}>Photos</th>
                  <th className={th}>Files</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((g) => {
                  const href = `/generations/${g.id.replace('batches/', '')}`;
                  return (
                    <tr key={g.id} className="hover:bg-slate-50">
                      <td className={td}>
                        <Link href={href} className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-white text-[10px] text-slate-400">
                          {g.photoFile ? (
                            // eslint-disable-next-line @next/next/no-img-element -- served by our own signed-in route, not a public URL
                            <img src={`${BASE_PATH}/api/file?path=${encodeURIComponent(g.photoFile)}&w=160`} alt="Pendant photo" loading="lazy" className="h-full w-full object-contain" />
                          ) : (
                            'None'
                          )}
                        </Link>
                      </td>
                      <td className={td}>
                        <Link href={href} className="block h-14 w-14 overflow-hidden rounded-lg border border-slate-200 bg-white">
                          {g.sketchFile ? (
                            // eslint-disable-next-line @next/next/no-img-element -- served by our own signed-in route, not a public URL
                            <img src={`${BASE_PATH}/api/file?path=${encodeURIComponent(g.sketchFile)}&w=160`} alt="Sketch" loading="lazy" className="h-full w-full object-contain" />
                          ) : null}
                        </Link>
                      </td>
                      <td className={`${td} whitespace-nowrap`}>
                        <Link href={href} className="font-medium text-slate-900 underline-offset-2 hover:underline">
                          {when(g.createdAt)}
                        </Link>
                      </td>
                      <td className={`${td} capitalize`}>{g.category}</td>
                      <td className={`${td} whitespace-nowrap`}>{g.madeBy ?? <span className="text-slate-400">Before team logins</span>}</td>
                      <td className={td}>{g.phone ?? <span className="text-slate-400">Shop staff</span>}</td>
                      <td className={td}>
                        <Status status={g.status} />
                        {g.parentId && <div className="mt-1 text-xs text-slate-500">Redraw</div>}
                        {g.ordered > 0 && <div className="mt-1 text-xs font-medium text-emerald-700">Ordered{g.ordered > 1 ? ` × ${g.ordered}` : ''}</div>}
                      </td>
                      <td className={`${td} whitespace-nowrap`}>
                        {g.liked + g.disliked === 0 ? (
                          <span className="text-slate-300">—</span>
                        ) : (
                          <span>
                            {g.liked > 0 && <span title="Looks right">👍 {g.liked}</span>} {g.disliked > 0 && <span title="Needs changes">👎 {g.disliked}</span>}
                          </span>
                        )}
                      </td>
                      <td className={`${td} tabular-nums`}>{g.photos}</td>
                      <td className={`${td} tabular-nums`}>{g.files}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
