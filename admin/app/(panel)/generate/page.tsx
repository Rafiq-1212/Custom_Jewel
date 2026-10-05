import { PageTitle } from '@/lib/ui';

/** The pendant tool itself, shown inside the panel. It is its own app; this is a window onto it. */
const TOOL_URL = process.env.TOOL_URL || 'https://true-b.vercel.app';

export default function GeneratePage() {
  return (
    <>
      <PageTitle title="Create a pendant" hint="The pendant tool. Anything made here shows up under Generations.">
        <a href={TOOL_URL} target="_blank" rel="noreferrer" className="text-sm text-slate-700 underline">
          Open in its own tab
        </a>
      </PageTitle>
      <iframe src={TOOL_URL} title="Pendant tool" className="h-[calc(100vh-9rem)] w-full rounded-xl border border-slate-200 bg-white" />
    </>
  );
}
