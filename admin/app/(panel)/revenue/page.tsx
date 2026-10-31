import { requireScreen } from '@/lib/auth';
import { amount, percent, when } from '@/lib/format';
import Link from 'next/link';
import { toRange, totals } from '@/lib/queries';
import { revenue } from '@/lib/shop-queries';
import { Card, Empty, PageTitle, RangePicker, Stat, td, th } from '@/lib/ui';

export default async function RevenuePage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  await requireScreen('revenue');
  const range = toRange((await searchParams).range);
  const [sales, t] = await Promise.all([revenue(range), totals(range)]);

  return (
    <>
      <PageTitle title="Revenue" hint="What the generated pictures turned into: orders and money in.">
        <RangePicker path="/revenue" range={range} />
      </PageTitle>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Paid orders" value={String(sales.count)} note={`${sales.fromGenerations} linked to a generated picture`} />
        <Stat label="Sketches that became orders" value={percent(sales.fromGenerations, t.done)} note={`${t.done} finished sketches`} />
        <Stat label="Revenue" value={amount(sales.total)} />
        <Stat label="Average order" value={sales.count ? amount(sales.total / sales.count) : '—'} note={sales.count ? `${sales.count} paid orders` : 'no orders yet'} />
      </div>

      <div className="mt-6">
        <Card title="Orders">
          {sales.orders.length === 0 ? (
            <Empty>No orders yet. Orders placed on the shop with a design from &quot;Upload your photo&quot; appear here.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className={th}>Order</th>
                    <th className={th}>When</th>
                    <th className={th}>Product</th>
                    <th className={th}>Customer</th>
                    <th className={th}>Design</th>
                    <th className={th}>Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {sales.orders.map((o) => (
                    <tr key={o.id}>
                      <td className={`${td} font-medium text-slate-900`}>{o.orderName ?? o.id}</td>
                      <td className={`${td} whitespace-nowrap`}>{when(o.createdAt)}</td>
                      <td className={td}>
                        {o.product ?? '—'}
                        {o.variant && <div className="text-xs text-slate-500">{o.variant}</div>}
                      </td>
                      <td className={`${td} whitespace-nowrap`}>{o.phone ?? '—'}</td>
                      <td className={td}>
                        {o.generationId ? (
                          <Link href={`/generations/${o.generationId.replace('batches/', '')}`} className="underline">
                            Open
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
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
