import { resetTries } from '@/lib/actions';
import { when } from '@/lib/format';
import { customers } from '@/lib/queries';
import { Card, Empty, PageTitle, td, th } from '@/lib/ui';

export default async function CustomersPage() {
  const rows = await customers();
  return (
    <>
      <PageTitle title="Customers and tries" hint="Each customer gets a set number of tries. Reset them here when someone runs out." />
      <Card>
        {rows.length === 0 ? (
          <Empty>No customers yet. They will appear here once people sign in with their phone number from the shop.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className={th}>Phone</th>
                  <th className={th}>Tries used</th>
                  <th className={th}>Generations</th>
                  <th className={th}>Orders</th>
                  <th className={th}>Last seen</th>
                  <th className={th} />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((c) => (
                  <tr key={c.phone}>
                    <td className={`${td} font-medium text-slate-900`}>{c.phone}</td>
                    <td className={`${td} tabular-nums ${c.triesUsed >= c.triesLimit ? 'font-medium text-rose-600' : ''}`}>
                      {c.triesUsed} of {c.triesLimit}
                    </td>
                    <td className={`${td} tabular-nums`}>{c.generations}</td>
                    <td className={`${td} tabular-nums`}>{c.orders}</td>
                    <td className={`${td} whitespace-nowrap`}>{when(c.lastSeenAt)}</td>
                    <td className={`${td} text-right`}>
                      <form action={resetTries}>
                        <input type="hidden" name="phone" value={c.phone} />
                        <button
                          type="submit"
                          disabled={c.triesUsed === 0}
                          className="rounded-lg border border-slate-300 px-3 py-1 text-sm text-slate-900 hover:bg-slate-50 disabled:opacity-40"
                        >
                          Reset tries
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
