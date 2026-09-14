'use client';

/**
 * Loading state. Cycles through three real phrases instead of a bare spinner
 * — the request genuinely takes up to a minute, and a static "Loading…" for
 * that long reads as stuck. No fixed percentage: we don't know how far along
 * the model actually is, so this shows a mood, not a number.
 */

import * as React from 'react';

const MESSAGES = [
  'Looking at your photo…',
  'Drawing the engraving…',
  'Nearly there…',
] as const;

/** How long each phrase holds before advancing to the next (ms). */
const STEP_MS = 4000;

export function GenerationProgress() {
  const [index, setIndex] = React.useState(0);

  React.useEffect(() => {
    const id = setInterval(() => {
      setIndex((current) => Math.min(current + 1, MESSAGES.length - 1));
    }, STEP_MS);
    return () => clearInterval(id);
  }, []);

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

      <p className="text-sm font-medium text-slate-700">{MESSAGES[index]}</p>

      <div className="flex gap-1.5">
        {MESSAGES.map((message, i) => (
          <span
            key={message}
            className={`h-1.5 w-6 rounded-full transition-colors ${
              i <= index ? 'bg-indigo-500' : 'bg-slate-200'
            }`}
          />
        ))}
      </div>

      <p className="text-xs text-slate-400">This can take up to a minute.</p>
    </div>
  );
}
