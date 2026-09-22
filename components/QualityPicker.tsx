'use client';

/**
 * Draft or full detail, chosen before the sketch is made.
 *
 * Both run exactly the same pipeline; the only difference is the canvas the
 * finish step draws on — 2K for a draft, 4K for the real thing (see
 * lib/sketch-pipeline.ts). Image output is billed per image rather than per
 * pixel, so the draft costs about a fifth less end to end and comes back
 * quicker, at the price of the finest detail: separate teeth, individual
 * eyelashes and single hair strands need the bigger canvas.
 *
 * It exists because a photo can fail for reasons a draft shows perfectly
 * well — the wrong framing, a hand across a face, the wrong person kept —
 * and finding that out at draft price is the point.
 */

import type { SketchQuality } from '@/lib/pendant-storage';

const OPTIONS: { id: SketchQuality; label: string; description: string }[] = [
  { id: 'final', label: 'Full detail', description: 'The sketch you order from.' },
  { id: 'draft', label: 'Quick draft', description: 'Cheaper preview, less fine detail.' },
];

export function QualityPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: SketchQuality;
  onChange: (quality: SketchQuality) => void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label="Sketch quality" className="grid grid-cols-2 gap-2.5">
      {OPTIONS.map((option) => {
        const selected = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(option.id)}
            className={`flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              selected
                ? 'border-slate-900 bg-slate-900/[0.04] text-slate-900'
                : 'border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-700'
            }`}
          >
            <span className="text-sm font-medium">{option.label}</span>
            <span className="text-xs text-slate-400">{option.description}</span>
          </button>
        );
      })}
    </div>
  );
}
