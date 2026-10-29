import Link from 'next/link';
import { canEdit } from '@/lib/access';
import { addTries, refillTries } from '@/lib/actions';
import { requireScreen } from '@/lib/auth';
import { when } from '@/lib/format';
import { customers, shopSettings } from '@/lib/shop-queries';
import { Card, Empty, PageTitle, td, th } from '@/lib/ui';
import { ShopSettingsForm } from './settings-form';

/** Shop customers: who signed in with their number, what they made and bought, and refilling their designs. */
export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const me = await requireScreen('customers');
  const q = (await searchParams).q ?? '';
  const [rows, settings] = await Promise.all([customers(q || null), shopSettings()]);
  const editor = canEdit(me);
  return (
    <>
      <PageTitle title="Customers and tries" hint="Everyone who signed in with their mobile number on the shop. Each gets a set number of designs. When someone calls after running out, refill them back to a full set, or add extra designs on top." />

      <Card title="Shop settings">
        <ShopSettingsForm supportPhone={settings.supportPhone} triesLimit={settings.triesLimit} editable={editor} />
      </Card>

      <form className="my-4 flex gap-2" action="/customers">
        <input name="q" defaultValue={q} placeholder="Search a number" inputMode="numeric" className="w-64 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" />
        <button type="submit" className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 hover:bg-slate-50">
          Search
        </button>
        {q && (
          <Link href="/customers" className="self-center text-sm text-slate-500 underline">
            Clear
          </Link>
        )}
      </form>

      <Card>
        {rows.length === 0 ? (
          <Empty>{q ? 'No customer with that number.' : 'No customers yet. They appear here once people sign in with their phone number from the shop.'}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className={th}>Phone</th>
                  <th className={th}>Designs used</th>
                  <th className={th}>Designs</th>
                  <th className={th}>Orders</th>
                  <th className={th}>Offers</th>
                  <th className={th}>Came from</th>
                  <th className={th}>Last seen</th>
                  <th className={th} />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((c) => {
                  const out = c.triesUsed >= c.triesLimit;
                  return (
                    <tr key={c.phone}>
                      <td className={`${td} whitespace-nowrap font-medium text-slate-900`}>{c.phone}</td>
                      <td className={`${td} whitespace-nowrap tabular-nums ${out ? 'font-medium text-rose-600' : ''}`}>
                        {c.triesUsed} of {c.triesLimit}
                        {out && <span className="ml-1 text-xs">· used up</span>}
                        {c.given && (
                          <span className="block text-xs font-normal text-slate-500">
                            {c.given.detail.startsWith('+') ? `${c.given.detail} added` : c.given.detail.replace('refilled', 'Refilled')} by {c.given.by}, {when(c.given.at)}
                          </span>
                        )}
                      </td>
                      <td className={`${td} tabular-nums`}>
                        {c.designs > 0 ? (
                          <Link href={`/generations?phone=${encodeURIComponent(c.phone)}`} className="underline">
                            {c.designs}
                          </Link>
                        ) : (
                          0
                        )}
                      </td>
                      <td className={`${td} tabular-nums`}>{c.orders}</td>
                      <td className={td}>{c.marketingConsent ? 'Yes' : '—'}</td>
                      <td className={`${td} text-xs`}>{c.source ?? '—'}</td>
                      <td className={`${td} whitespace-nowrap`}>{when(c.lastSeenAt)}</td>
                      <td className={`${td} text-right`}>
                        {editor && (
                          <div className="flex items-center justify-end gap-2">
                            <form action={refillTries}>
                              <input type="hidden" name="phone" value={c.phone} />
                              <button
                                type="submit"
                                disabled={c.triesUsed === 0}
                                title="Back to a full set: what they have used goes back to 0."
                                className="whitespace-nowrap rounded-lg border border-slate-300 px-3 py-1 text-sm text-slate-900 hover:bg-slate-50 disabled:opacity-40"
                              >
                                Refill designs
                              </button>
                            </form>
                            <form action={addTries} className="flex items-center gap-1">
                              <input type="hidden" name="phone" value={c.phone} />
                              <input
                                name="extra"
                                type="number"
                                min={1}
                                max={20}
                                defaultValue={1}
                                aria-label={`Extra designs for ${c.phone}`}
                                className="w-14 rounded-lg border border-slate-300 px-2 py-1 text-sm tabular-nums"
                              />
                              <button type="submit" title="Extra designs on top of what they have left." className="whitespace-nowrap rounded-lg bg-slate-900 px-3 py-1 text-sm font-medium text-white hover:bg-slate-800">
                                Add
                              </button>
                            </form>
                          </div>
                        )}
                      </td>
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
