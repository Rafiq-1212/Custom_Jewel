'use client';

/**
 * Crop box over the uploaded photo. Drag inside the box to move it, drag a
 * corner or edge handle to resize it; everything outside is dimmed. The
 * rect is kept as fractions of the photo (lib/photo-crop.ts), so it is
 * independent of how large the photo happens to be displayed.
 *
 * Pointer events (mouse, touch and pen alike) with pointer capture, so a
 * drag keeps tracking even when the pointer leaves the box.
 */

import * as React from 'react';
import { FULL_CROP, clampCrop, isFullCrop, type CropRect } from '@/lib/photo-crop';

type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const HANDLES: { id: Exclude<Handle, 'move'>; className: string }[] = [
  { id: 'nw', className: 'left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize' },
  { id: 'n', className: 'left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize' },
  { id: 'ne', className: 'right-0 top-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize' },
  { id: 'e', className: 'right-0 top-1/2 translate-x-1/2 -translate-y-1/2 cursor-ew-resize' },
  { id: 'se', className: 'right-0 bottom-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize' },
  { id: 's', className: 'left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-ns-resize' },
  { id: 'sw', className: 'left-0 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize' },
  { id: 'w', className: 'left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize' },
];

export function PhotoCropper({
  src,
  crop,
  onChange,
  disabled,
}: {
  src: string;
  crop: CropRect;
  onChange: (crop: CropRect) => void;
  disabled?: boolean;
}) {
  const frameRef = React.useRef<HTMLDivElement>(null);
  const dragRef = React.useRef<{ handle: Handle; startX: number; startY: number; start: CropRect } | null>(null);

  const beginDrag = (handle: Handle, event: React.PointerEvent) => {
    if (disabled) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { handle, startX: event.clientX, startY: event.clientY, start: crop };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    const frame = frameRef.current;
    if (!drag || !frame) return;
    const bounds = frame.getBoundingClientRect();
    const dx = (event.clientX - drag.startX) / bounds.width;
    const dy = (event.clientY - drag.startY) / bounds.height;
    const s = drag.start;
    let next: CropRect;

    if (drag.handle === 'move') {
      next = { ...s, x: s.x + dx, y: s.y + dy };
    } else {
      let left = s.x;
      let top = s.y;
      let right = s.x + s.width;
      let bottom = s.y + s.height;
      if (drag.handle.includes('w')) left = Math.min(right - 0.02, s.x + dx);
      if (drag.handle.includes('e')) right = Math.max(left + 0.02, s.x + s.width + dx);
      if (drag.handle.includes('n')) top = Math.min(bottom - 0.02, s.y + dy);
      if (drag.handle.includes('s')) bottom = Math.max(top + 0.02, s.y + s.height + dy);
      left = Math.max(0, left);
      top = Math.max(0, top);
      right = Math.min(1, right);
      bottom = Math.min(1, bottom);
      next = { x: left, y: top, width: right - left, height: bottom - top };
    }
    onChange(clampCrop(next));
  };

  const endDrag = (event: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
  };

  const pct = (value: number) => `${(value * 100).toFixed(3)}%`;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Your photo</p>
        {!isFullCrop(crop) && (
          <button
            type="button"
            onClick={() => onChange(FULL_CROP)}
            disabled={disabled}
            className="text-xs font-medium text-slate-500 underline-offset-4 hover:text-slate-700 hover:underline disabled:opacity-50"
          >
            Reset crop
          </button>
        )}
      </div>

      <div
        ref={frameRef}
        className="relative select-none overflow-hidden rounded-2xl border border-slate-200 bg-slate-900 shadow-sm"
        style={{ touchAction: 'none' }}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="Your uploaded photo" className="block h-auto w-full" draggable={false} />

        <div
          role="group"
          aria-label="Crop area"
          className={`absolute border-2 border-white shadow-[0_0_0_9999px_rgba(15,23,42,0.55)] ${
            disabled ? 'cursor-default' : 'cursor-move'
          }`}
          style={{ left: pct(crop.x), top: pct(crop.y), width: pct(crop.width), height: pct(crop.height) }}
          onPointerDown={(event) => beginDrag('move', event)}
        >
          {/* Rule-of-thirds guides, purely visual. */}
          <div aria-hidden className="pointer-events-none absolute inset-0">
            <div className="absolute left-1/3 top-0 h-full w-px bg-white/40" />
            <div className="absolute left-2/3 top-0 h-full w-px bg-white/40" />
            <div className="absolute left-0 top-1/3 h-px w-full bg-white/40" />
            <div className="absolute left-0 top-2/3 h-px w-full bg-white/40" />
          </div>
          {!disabled &&
            HANDLES.map((handle) => (
              <div
                key={handle.id}
                role="presentation"
                className={`absolute size-4 rounded-sm border border-slate-700 bg-white ${handle.className}`}
                onPointerDown={(event) => beginDrag(handle.id, event)}
              />
            ))}
        </div>
      </div>

      <p className="text-xs text-slate-400">
        Drag the box around the people you want in the sketch. Leave out stretched-out arms, other people and busy
        backgrounds. Only what&apos;s inside the box gets drawn.
      </p>
    </div>
  );
}
