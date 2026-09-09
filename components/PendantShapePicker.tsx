'use client';

/**
 * Shape selector. Purely a `setSelectedShape` call on click — never triggers
 * any generation. Icons are the exact same path data the canvas renderer
 * uses, so a new entry in `PENDANT_SHAPES` automatically gets a matching
 * picker button with no separate icon asset to draw.
 */

import { PENDANT_SHAPE_LIST, PENDANT_VIEWBOX, type PendantShape, type ShapeId } from '@/lib/pendant-shapes';

function ShapeIcon({ shape }: { shape: PendantShape }) {
  return (
    <svg viewBox={`0 0 ${PENDANT_VIEWBOX.width} ${PENDANT_VIEWBOX.height}`} className="size-9" aria-hidden>
      <path d={shape.path} fill="currentColor" />
    </svg>
  );
}

export function PendantShapePicker({
  value,
  onChange,
}: {
  value: ShapeId;
  onChange: (shape: ShapeId) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Pendant shape"
      className="grid grid-cols-3 gap-2.5 sm:grid-cols-4 md:grid-cols-7"
    >
      {PENDANT_SHAPE_LIST.map((shape) => {
        const selected = shape.id === value;
        return (
          <button
            key={shape.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(shape.id)}
            className={`flex flex-col items-center gap-2 rounded-xl border p-3 transition-colors ${
              selected
                ? 'border-slate-900 bg-slate-900/[0.04] text-slate-900'
                : 'border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-700'
            }`}
          >
            <ShapeIcon shape={shape} />
            <span className="text-xs font-medium">{shape.label}</span>
          </button>
        );
      })}
    </div>
  );
}
