import { amount, percent, rupees, when } from '@/lib/format';
import { revenue, toRange, totals } from '@/lib/queries';
import { Card, Empty, PageTitle, RangePicker, Stat, td, th } from '@/lib/ui';

const INR_PER_USD = Number(process.env.INR_PER_USD) || 95.6;

export default async function RevenuePage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const range = toRange((await searchParams).range);
  const [sales, t] = await Promise.all([revenue(range), totals(range)]);
  const spend = t.spendUsd * INR_PER_USD;

  return (
    <>
      <PageTitle title="Revenue" hint="What the generated pictures turned into: orders, money in, and money spent making them.">
        <RangePicker path="/revenue" range={range} />
      </PageTitle>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Paid orders" value={String(sales.count)} note={`${sales.fromGenerations} linked to a generated picture`} />
        <Stat label="Sketches that became orders" value={percent(sales.fromGenerations, t.done)} note={`${t.done} finished sketches`} />
        <Stat label="Revenue" value={amount(sales.total)} />
        <Stat label="Spent on Gemini" value={rupees(t.spendUsd)} note={sales.count ? `${amount(spend / sales.count)} per order` : 'no orders yet'} />
      </div>

      <div className="mt-6">
        <Card title="Orders">
          {sales.orders.length === 0 ? (
            <Empty>No orders yet. They will appear here once the shop is connected and sends its paid orders.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className={th}>Order</th>
                    <th className={th}>When</th>
                    <th className={th}>Customer</th>
                    <th className={th}>From a generation</th>
                    <th className={th}>Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {sales.orders.map((o) => (
                    <tr key={o.id}>
                      <td className={`${td} font-medium text-slate-900`}>{o.id}</td>
                      <td className={`${td} whitespace-nowrap`}>{when(o.createdAt)}</td>
                      <td className={td}>{o.phone ?? '—'}</td>
                      <td className={td}>{o.folder ? 'Yes' : 'No'}</td>
                      <td className={`${td} tabular-nums`}>{amount(o.amount, o.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
