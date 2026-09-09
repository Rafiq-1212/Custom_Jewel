'use client';

/**
 * Design-type selector: Standard (a catalogue shape, lib/pendant-shapes.ts)
 * vs Edge Cut (the pendant's outer boundary follows the artwork's own
 * silhouette — lib/edge-cut-contour.ts). Purely a `setSelectedDesignType`
 * call, same as every other picker in this app — never touches the AI.
 */

import type { DesignType } from '@/lib/pendant-geometry';

const OPTIONS: { id: DesignType; label: string; description: string }[] = [
  { id: 'standard', label: 'Standard Pendant', description: 'A catalogue shape — heart, diamond, hexagon and more.' },
  { id: 'edge-cut', label: 'Edge Cut', description: "The metal follows the artwork's own silhouette." },
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
