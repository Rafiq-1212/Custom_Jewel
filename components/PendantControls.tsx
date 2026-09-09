'use client';

/**
 * Zoom / position / rotation sliders. Every one of these edits the existing
 * sketch's placement only — none of them ever calls the AI, and the whole
 * component is one plain `onChange(nextTransform)` callback, so the parent's
 * `setTransform` is the only thing that runs.
 */

import { DEFAULT_TRANSFORM, type PendantTransform } from '@/lib/pendant-shapes';

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="flex items-center justify-between text-slate-600">
        <span>{label}</span>
        <span className="tabular-nums text-xs text-slate-400">
          {format ? format(value) : value}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-slate-900"
      />
    </label>
  );
}

export function PendantControls({
  transform,
  onChange,
}: {
  transform: PendantTransform;
  onChange: (transform: PendantTransform) => void;
}) {
  const set = (patch: Partial<PendantTransform>) => onChange({ ...transform, ...patch });
  const isDefault =
    transform.zoom === DEFAULT_TRANSFORM.zoom &&
    transform.x === DEFAULT_TRANSFORM.x &&
    transform.y === DEFAULT_TRANSFORM.y &&
    transform.rotation === DEFAULT_TRANSFORM.rotation;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Slider
          label="Zoom"
          value={transform.zoom}
          min={0.5}
          max={3}
          step={0.05}
          onChange={(zoom) => set({ zoom })}
          format={(v) => `${v.toFixed(2)}x`}
        />
        <Slider
          label="Rotate"
          value={transform.rotation}
          min={-180}
          max={180}
          step={1}
          onChange={(rotation) => set({ rotation })}
          format={(v) => `${v}°`}
        />
        <Slider
          label="Position X"
          value={transform.x}
          min={-30}
          max={30}
          step={0.5}
          onChange={(x) => set({ x })}
        />
        <Slider
          label="Position Y"
          value={transform.y}
          min={-30}
          max={30}
          step={0.5}
          onChange={(y) => set({ y })}
        />
      </div>
      <button
        type="button"
        onClick={() => onChange(DEFAULT_TRANSFORM)}
        disabled={isDefault}
        className="self-start text-xs font-medium text-slate-500 underline-offset-4 hover:text-slate-700 hover:underline disabled:cursor-not-allowed disabled:opacity-40 disabled:no-underline"
      >
        Reset adjustments
      </button>
    </div>
  );
}
