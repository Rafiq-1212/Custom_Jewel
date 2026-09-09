'use client';

/**
 * Edge-cut style selector, shown only when `designType === 'edge-cut'`.
 * Purely a `setSelectedEdgeCutStyle` call — never touches the AI or
 * recomputes any traced silhouette itself.
 *
 * 'bust' and 'band' need a silhouette traced from the *original* uploaded
 * photo (lib/photo-silhouette.ts) to look right — the sketch-based fallback
 * (lib/edge-cut-contour.ts) covers 'free'/'heart' well enough, but truncating
 * it into a bust base or offsetting it into a border band would just amplify
 * its inaccuracy. `disabledStyles` lets the parent grey those two out (with a
 * reason) when the original photo isn't available this session — e.g. after
 * a page reload, since the raw photo is deliberately never persisted.
 */

import type { EdgeCutStyle } from '@/lib/pendant-geometry';

const OPTIONS: { id: EdgeCutStyle; label: string; description: string }[] = [
  { id: 'free', label: 'Free Edge Cut', description: "The metal edge follows the artwork's outline directly." },
  { id: 'heart', label: 'Edge Cut inside Heart', description: 'Heart-shaped metal; the artwork inside is cut to its own silhouette.' },
  { id: 'bust', label: 'Bust with Base', description: 'Head and shoulders, closing into a rounded-rectangle base.' },
  { id: 'band', label: 'Silhouette Band', description: 'The silhouette with a wider outer border band.' },
];

export function EdgeCutStylePicker({
  value,
  onChange,
  disabled,
  disabledStyles,
  disabledReason,
}: {
  value: EdgeCutStyle;
  onChange: (edgeCutStyle: EdgeCutStyle) => void;
  /** Disables every option — used while no silhouette at all is ready yet. */
  disabled?: boolean;
  /** Disables only these specific options (e.g. 'bust'/'band' without a photo-based silhouette). */
  disabledStyles?: EdgeCutStyle[];
  disabledReason?: string;
}) {
  return (
    <div role="radiogroup" aria-label="Edge cut style" className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
      {OPTIONS.map((option) => {
        const selected = option.id === value;
        const optionDisabled = disabled || disabledStyles?.includes(option.id);
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.id)}
            disabled={optionDisabled}
            title={optionDisabled && disabledReason ? disabledReason : undefined}
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
