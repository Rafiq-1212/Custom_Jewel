'use client';

/**
 * Loading state, and a long one: the drawing is queued as a batch job at half
 * price, which took 87 seconds for the photo edit and 379 for the 4K drawing
 * in the jobs measured. A spinner alone reads as stuck over that long, so
 * this shows which of the three real stages the work is actually at — the
 * stage comes from the run itself (lib/sketch-client.ts), not from a timer,
 * so it never claims progress that has not happened.
 */

import * as React from 'react';
import type { SketchStage } from '@/lib/sketch-client';

const STAGES: { id: SketchStage; message: string }[] = [
  { id: 'touching-up', message: 'Touching up your photo…' },
  { id: 'drawing', message: 'Inking the lines…' },
  { id: 'finishing', message: 'Finishing the artwork…' },
];

export function GenerationProgress({ stage }: { stage: SketchStage }) {
  const index = Math.max(0, STAGES.findIndex((s) => s.id === stage));

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col items-center gap-5 rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-sm"
    >
      <div className="relative size-16">
        <span className="absolute inset-0 animate-ping rounded-full bg-indigo-300 opacity-40" />
        <span className="absolute inset-2 animate-pulse rounded-full bg-indigo-400 opacity-60" />
        <span className="absolute inset-5 rounded-full bg-indigo-600" />
      </div>

      <p className="text-sm font-medium text-slate-700">{STAGES[index].message}</p>

      <div className="flex gap-1.5">
        {STAGES.map((entry, i) => (
          <span
            key={entry.id}
            className={`h-1.5 w-6 rounded-full transition-colors ${
              i <= index ? 'bg-indigo-500' : 'bg-slate-200'
            }`}
          />
        ))}
      </div>

      <p className="text-xs text-slate-400">
        This takes a few minutes. The drawing is queued at half price, so it is worth the wait — leave this page open.
      </p>
    </div>
  );
}
