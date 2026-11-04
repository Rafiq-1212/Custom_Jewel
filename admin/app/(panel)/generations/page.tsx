import Link from 'next/link';
import { BASE_PATH } from '@/lib/base-path';
import { canSeeCosts, viewerOf } from '@/lib/access';
import { requireScreen } from '@/lib/auth';
import { rupees, when } from '@/lib/format';
import { generations, makers } from '@/lib/queries';
import { customers } from '@/lib/shop-queries';
import { RemakeButton } from './[id]/remake';
import { Card, Empty, PageTitle, Stat, Status, td, th } from '@/lib/ui';

const ABANDONED = new Set(['abandoned', 'left_before_photo']);

export default async function DesignsPage({ searchParams }: { searchParams: Promise<{ by?: string; phone?: string; status?: string; from?: string }> }) {
  const me = await requireScreen('designs');
  const params = await searchParams;
  const by = params.by || null;
  const phone = params.phone || null;
  const abandonedOnly = params.status === 'abandoned';
  const costs = canSeeCosts(me);
  // Back goes where this list was opened from: Customers, or Designs.
  const fromCustomers = params.from === 'customers';
  // A design opened from here comes back to this same list.
  const listQuery = new URLSearchParams(Object.entries({ by, phone, status: params.status, from: fromCustomers ? 'customers' : null }).filter((e): e is [string, string] => Boolean(e[1]))).toString();
  // One customer's designs: every one, not just the latest 200 of the shop.
  const [all, people, found] = await Promise.all([
    generations(phone ? 1000 : 200, by, phone, viewerOf(me)),
    makers(),
    phone ? customers(phone) : Promise.resolve([]),
  ]);
  const customer = found.find((c) => c.phone === phone) ?? null;
  const rows = abandonedOnly ? all.filter((g) => ABANDONED.has(g.status)) : all;
  const chip = (active: boolean) =>
    `rounded-full border px-3 py-1 text-sm ${active ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`;
  return (
    <>
      {phone ? (
        <>
          <Link href={fromCustomers ? '/customers' : '/generations'} className="mb-4 inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
            <span aria-hidden>←</span> {fromCustomers ? 'Back to customers' : 'Back to designs'}
          </Link>
          <PageTitle title={`Customer ${phone}`} hint="Every design this customer made, newest first, with the photo they uploaded. Open one to see all its pictures and files, or make it again from the uploaded photo." />
          <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Designs" value={String(all.length)} note={`${all.filter((g) => g.status === 'done' || g.status === 'left_before_photo').length} finished · ${all.filter((g) => g.status === 'failed').length} failed`} />
            <Stat label="Designs used" value={customer ? `${customer.triesUsed} of ${customer.triesLimit}` : '—'} note={customer ? `last seen ${when(customer.lastSeenAt)}` : undefined} />
            {costs && <Stat label="Gemini cost" value={rupees(all.reduce((sum, g) => sum + g.costUsd, 0))} note="all their designs together" />}
            <Stat label="Orders" value={String(all.reduce((sum, g) => sum + g.ordered, 0))} note={`${all.filter((g) => g.photos > 0).length} designs got a pendant photo`} />
          </div>
        </>
      ) : (
        <PageTitle title="Designs" hint="Every design, newest first: the pendant photo that was made, and who made it — a team member or a shop customer by their number. Abandoned ones show whether they were left while drawing or before the pendant photo." />
      )}
      {!phone && people.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-sm text-slate-500">Made by</span>
          <Link href="/generations" className={chip(!by && !phone && !abandonedOnly)}>
            Everyone
          </Link>
          <Link href="/generations?status=abandoned" className={chip(abandonedOnly)}>
            Abandoned
          </Link>
          {people.map((p) => (
            <Link key={p.id} href={`/generations?by=${p.id}`} className={chip(by === p.id)}>
              {p.name}
            </Link>
          ))}
        </div>
      )}
      <Card>
        {rows.length === 0 ? (
          <Empty>{phone ? 'This customer has not made a design yet.' : abandonedOnly ? 'Nothing abandoned among the latest designs.' : by ? 'Nothing made by this person yet.' : 'Nothing has been made since tracking was switched on.'}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className={th}>Uploaded photo</th>
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
                  {costs && <th className={th}>Gemini cost</th>}
                  <th className={th}>Make it again</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((g) => {
                  const href = `/generations/${g.id.replace('batches/', '')}${listQuery ? `?${listQuery}` : ''}`;
                  return (
                    <tr key={g.id} className="hover:bg-slate-50">
                      <td className={td}>
                        <Link href={href} className="block h-14 w-14 overflow-hidden rounded-lg border border-slate-200 bg-white">
                          {g.uploadFile ? (
                            // eslint-disable-next-line @next/next/no-img-element -- served by our own signed-in route, not a public URL
                            <img src={`${BASE_PATH}/api/file?path=${encodeURIComponent(g.uploadFile)}&w=160`} alt="Uploaded photo" loading="lazy" className="h-full w-full object-cover" />
                          ) : null}
                        </Link>
                      </td>
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
                      <td className={`${td} whitespace-nowrap`}>
                        {g.phone ? (
                          phone ? (
                            g.phone
                          ) : (
                            <Link href={`/generations?phone=${encodeURIComponent(g.phone)}`} className="underline underline-offset-2" title="See every design this customer made">
                              {g.phone}
                            </Link>
                          )
                        ) : (
                          <span className="text-slate-400">Shop staff</span>
                        )}
                      </td>
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
                      {costs && <td className={`${td} whitespace-nowrap tabular-nums font-medium text-slate-900`}>{rupees(g.costUsd)}</td>}
                      <td className={td}>{g.uploadFile && <RemakeButton job={g.id} category={g.category} forCustomer={g.phone !== null} compact />}</td>
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
