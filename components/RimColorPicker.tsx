'use client';

/**
 * Enamel rim selector for the catalogue's "Heart with Color" / "Round with
 * Color" plates. Purely a `setRimColor` call — the canvas renderer strokes a
 * band and the mockup prompt mentions it; nothing else changes and the AI
 * sketch is never regenerated.
 */

import { RIM_COLOR_LIST, type RimColorId } from '@/lib/materials';

export function RimColorPicker({ value, onChange }: { value: RimColorId; onChange: (rim: RimColorId) => void }) {
  return (
    <div role="radiogroup" aria-label="Enamel rim" className="flex flex-wrap gap-3">
      {RIM_COLOR_LIST.map((rim) => {
        const selected = rim.id === value;
        return (
          <button
            key={rim.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(rim.id)}
            className={`flex items-center gap-2.5 rounded-full border px-4 py-2 transition-colors ${
              selected ? 'border-slate-900 bg-slate-900/[0.04]' : 'border-slate-200 hover:border-slate-300'
            }`}
          >
            <span
              aria-hidden
              className="size-5 rounded-full border-2 border-slate-300"
              style={rim.hex ? { borderColor: rim.hex, background: 'transparent' } : undefined}
            />
            <span className="text-sm font-medium text-slate-800">{rim.label}</span>
          </button>
        );
      })}
    </div>
  );
}
