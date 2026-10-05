import Link from 'next/link';
import { rupees, when } from '@/lib/format';
import { generations } from '@/lib/queries';
import { Card, Empty, PageTitle, Status, td, th } from '@/lib/ui';

export default async function GenerationsPage() {
  const rows = await generations();
  return (
    <>
      <PageTitle title="Generations" hint="Every photo that went in, newest first. Open one to see it end to end." />
      <Card>
        {rows.length === 0 ? (
          <Empty>Nothing has been generated since tracking was switched on.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className={th}>Sketch</th>
                  <th className={th}>Started</th>
                  <th className={th}>Style</th>
                  <th className={th}>Customer</th>
                  <th className={th}>Status</th>
                  <th className={th}>Photos</th>
                  <th className={th}>Files</th>
                  <th className={th}>Cost so far</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((g) => {
                  const href = `/generations/${g.id.replace('batches/', '')}`;
                  return (
                    <tr key={g.id} className="hover:bg-slate-50">
                      <td className={td}>
                        <Link href={href} className="block h-14 w-14 overflow-hidden rounded-lg border border-slate-200 bg-white">
                          {g.sketchFile ? (
                            // eslint-disable-next-line @next/next/no-img-element -- served by our own signed-in route, not a public URL
                            <img src={`/api/file?path=${encodeURIComponent(g.sketchFile)}`} alt="Sketch" loading="lazy" className="h-full w-full object-contain" />
                          ) : null}
                        </Link>
                      </td>
                      <td className={`${td} whitespace-nowrap`}>
                        <Link href={href} className="font-medium text-slate-900 underline-offset-2 hover:underline">
                          {when(g.createdAt)}
                        </Link>
                      </td>
                      <td className={`${td} capitalize`}>{g.category}</td>
                      <td className={td}>{g.phone ?? <span className="text-slate-400">Shop staff</span>}</td>
                      <td className={td}>
                        <Status status={g.status} />
                      </td>
                      <td className={`${td} tabular-nums`}>{g.photos}</td>
                      <td className={`${td} tabular-nums`}>{g.files}</td>
                      <td className={`${td} tabular-nums font-medium text-slate-900`}>{rupees(g.costUsd)}</td>
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
