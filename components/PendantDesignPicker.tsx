'use client';

/**
 * Design-type selector: Silhouette Cut (the metal follows the artwork's own
 * outline — the catalogue's Face / Half Size / Couple / Family / Pet
 * pendants) vs Shape Pendant (a catalogue plate, lib/pendant-shapes.ts).
 * Purely a `setSelectedDesignType` call, same as every other picker in this
 * app — never touches the AI.
 */

import type { DesignType } from '@/lib/pendant-geometry';

const OPTIONS: { id: DesignType; label: string; description: string }[] = [
  {
    id: 'edge-cut',
    label: 'Silhouette Cut',
    description: "The metal is cut along the artwork's own outline, with its hanging ring — Face, Half Size, Couple, Family, Pet.",
  },
  {
    id: 'standard',
    label: 'Shape Pendant',
    description: 'A catalogue plate — Round, Oval, Heart, Bar, Tag or Octagonal.',
  },
];

export function PendantDesignPicker({
  value,
  onChange,
  disabled,
}: {
  value: DesignType;
  onChange: (designType: DesignType) => void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label="Pendant design" className="grid grid-cols-2 gap-2.5">
      {OPTIONS.map((option) => {
        const selected = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.id)}
            disabled={disabled}
            className={`flex flex-col items-start gap-1 rounded-xl border p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
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
