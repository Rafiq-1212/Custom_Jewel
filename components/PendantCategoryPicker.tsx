'use client';

/**
 * Category selector. Purely a `setSelectedCategory` call — never touches the
 * AI or `masterSketch` itself. Rendered BEFORE generation (see app/page.tsx):
 * the selected category is what `generateSketch` sends to `/api/generate-
 * image` to pick Gemini's framing prompt. It also keeps its original,
 * unrelated role afterwards — the same category still selects which
 * `engravingArea` framing preset (lib/pendant-categories.ts) the preview and
 * exports fit the resulting sketch into.
 */

import { PENDANT_CATEGORY_LIST, type CategoryId, type PendantCategory } from '@/lib/pendant-categories';

export function PendantCategoryPicker({
  value,
  onChange,
  categories = PENDANT_CATEGORY_LIST,
}: {
  /** `null` before the customer has picked one yet — no radio starts selected. */
  value: CategoryId | null;
  onChange: (category: CategoryId) => void;
  /** Defaults to every category. Callers before Gemini generation pass the content-only subset (see `GENERATION_CATEGORY_LIST`). */
  categories?: PendantCategory[];
}) {
  return (
    <div role="radiogroup" aria-label="Pendant category" className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
      {categories.map((category) => {
        const selected = category.id === value;
        return (
          <button
            key={category.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(category.id)}
            title={category.description}
            className={`flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition-colors ${
              selected
                ? 'border-slate-900 bg-slate-900/[0.04] text-slate-900'
                : 'border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-700'
            }`}
          >
            <span className="text-sm font-medium">{category.label}</span>
            <span className="text-xs text-slate-400">{category.description}</span>
          </button>
        );
      })}
    </div>
  );
}
