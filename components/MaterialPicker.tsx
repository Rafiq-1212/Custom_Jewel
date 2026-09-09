'use client';

/**
 * Material selector. Purely a `setSelectedMaterial` call on click — the
 * canvas renderer just picks a different gradient. Never regenerates the
 * sketch, never calls the AI.
 */

import { PENDANT_MATERIAL_LIST, type MaterialId } from '@/lib/materials';

export function MaterialPicker({
  value,
  onChange,
}: {
  value: MaterialId;
  onChange: (material: MaterialId) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Material" className="flex gap-3">
      {PENDANT_MATERIAL_LIST.map((material) => {
        const selected = material.id === value;
        return (
          <button
            key={material.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(material.id)}
            className={`flex items-center gap-2.5 rounded-full border px-4 py-2 transition-colors ${
              selected
                ? 'border-slate-900 bg-slate-900/[0.04]'
                : 'border-slate-200 hover:border-slate-300'
            }`}
          >
            <span
              aria-hidden
              className="size-5 rounded-full border border-black/10"
              style={{
                background: `radial-gradient(circle at 32% 28%, ${material.gradient[2]}, ${material.swatch} 55%, ${material.gradient[4]})`,
              }}
            />
            <span className="text-sm font-medium text-slate-800">{material.label}</span>
          </button>
        );
      })}
    </div>
  );
}
