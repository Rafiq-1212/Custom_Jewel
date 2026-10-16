import { PageTitle } from '@/lib/ui';

/**
 * The pendant tool itself, shown inside the panel: the same site, one level
 * up. It is its own app; this is a window onto it. The tool lets itself be
 * shown in a frame, and opens on a page of its own with ?full=1 (its proxy.ts).
 */
const TOOL_URL = '/';

export default function GeneratePage() {
  return (
    <>
      <PageTitle title="Create a pendant" hint="The pendant tool. Everything made here shows up under Designs.">
        <a href={`${TOOL_URL}?full=1`} target="_blank" rel="noreferrer" className="text-sm text-slate-700 underline">
          Open in its own tab
        </a>
      </PageTitle>
      <iframe src={TOOL_URL} title="Pendant tool" className="h-[calc(100vh-9rem)] w-full rounded-xl border border-slate-200 bg-white" />
    </>
  );
}
