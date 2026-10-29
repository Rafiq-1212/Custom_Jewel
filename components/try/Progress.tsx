'use client';

/**
 * How far along a customer's design is. The stages are real (the sketch
 * client reports them); within a stage the bar creeps on towards the next
 * one at the speed the stage usually takes, and waits there if it runs long,
 * rather than claiming a finish it cannot know.
 */

import * as React from 'react';

export type Stage = 'uploading' | 'touching-up' | 'inking' | 'finishing' | 'photo' | 'done';

/** Where each stage starts on the bar, where it may reach, and roughly how long it takes (seconds). */
const STAGES: Record<Stage, { from: number; to: number; seconds: number; text: string }> = {
  uploading: { from: 2, to: 6, seconds: 5, text: 'Uploading your photo…' },
  'touching-up': { from: 6, to: 24, seconds: 30, text: 'Preparing your photo…' },
  inking: { from: 24, to: 76, seconds: 200, text: 'Drawing your pendant. This takes about 2 to 4 minutes.' },
  finishing: { from: 76, to: 82, seconds: 10, text: 'Finishing the drawing…' },
  photo: { from: 82, to: 98, seconds: 120, text: 'Making the photo of your pendant…' },
  done: { from: 100, to: 100, seconds: 1, text: 'Ready!' },
};

/** Keyed by its stage where it is used, so each stage starts its own clock. */
export function Progress({ stage }: { stage: Stage }) {
  const [since] = React.useState(() => Date.now());
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);

  const step = STAGES[stage];
  const elapsed = Math.max(0, (now - since) / 1000);
  // Eases towards the stage's end: two thirds of the way by its usual time.
  const share = 1 - Math.exp(-elapsed / step.seconds);
  const percent = Math.round(step.from + (step.to - step.from) * share);

  return (
    <div className="flex flex-col gap-3" role="status" aria-live="polite">
      <div className="h-3 w-full overflow-hidden rounded-full bg-slate-100">
        <div className="h-full rounded-full bg-amber-500 transition-[width] duration-500" style={{ width: `${percent}%` }} />
      </div>
      <div className="flex justify-between text-sm">
        <span className="text-slate-700">{step.text}</span>
        <span className="tabular-nums text-slate-500">{percent}%</span>
      </div>
    </div>
  );
}
