'use client';


import * as React from 'react';
import { ACCEPTED_IMAGE_EXTENSIONS, ACCEPTED_IMAGE_LABEL, MAX_IMAGE_LABEL, quickValidate } from '@/lib/validation';

export function ImageUploader({
  onFileSelected,
  onValidationError,
  disabled,
}: {
  onFileSelected: (file: File) => void;
  onValidationError: (message: string) => void;
  disabled?: boolean;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);

  const accept = (file: File | undefined) => {
    if (disabled) return;
    const result = quickValidate(file);
    if (!result.ok) {
      onValidationError(result.message);
      return;
    }
    onFileSelected(file!);
  };

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        accept(event.dataTransfer.files?.[0]);
      }}
      className={`rounded-2xl border-2 border-dashed p-10 text-center transition-colors ${
        dragging ? 'border-indigo-400 bg-indigo-50' : 'border-slate-300 bg-white'
      } ${disabled ? 'opacity-60' : ''}`}
    >
      <svg
        className="mx-auto size-10 text-slate-400"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={1.5}
        stroke="currentColor"
        aria-hidden
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 8.25 12 3.75m0 0L7.5 8.25M12 3.75v13.5"
        />
      </svg>

      <p className="mt-3 text-sm text-slate-600">Drop a photo here, or</p>

      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        className="mt-3 inline-flex items-center gap-2 rounded-full bg-slate-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Choose a photo
      </button>

      <input
        ref={inputRef}
        type="file"
        accept={`image/jpeg,image/png,image/webp,${ACCEPTED_IMAGE_EXTENSIONS}`}
        disabled={disabled}
        className="sr-only"
        onChange={(event) => {
          accept(event.target.files?.[0]);
          // Allow selecting the same file again after an error or a redo.
          event.target.value = '';
        }}
      />

      <p className="mt-4 text-xs text-slate-400">
        {ACCEPTED_IMAGE_LABEL} · up to {MAX_IMAGE_LABEL}
      </p>
    </div>
  );
}
