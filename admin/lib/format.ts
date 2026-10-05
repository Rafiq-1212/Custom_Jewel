/** Rupees per dollar: the same figure the pendant tool logs its costs with. */
const INR_PER_USD = Number(process.env.INR_PER_USD) || 95.6;

/** A dollar cost as rupees, e.g. "₹11.58". */
export function rupees(usd: number | string | null | undefined): string {
  const value = Number(usd ?? 0) * INR_PER_USD;
  return `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A rupee amount as it is. */
export function amount(value: number | string | null | undefined, currency = 'INR'): string {
  return `${currency === 'INR' ? '₹' : `${currency} `}${Number(value ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

/** A moment in Indian time, e.g. "5 Oct 2026, 10:13". */
export function when(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((100 * part) / whole)}%` : '—';
}

const STEP_NAMES: Record<string, string> = {
  sketch_start: 'Photo edited, drawing queued',
  sketch_done: 'Drawing finished',
  sketch_redo: 'Drawing redone (came back out of frame)',
  sketch_failed: 'Sketch failed',
  product_photo: 'Product photo',
  production_files: 'Production files',
};

export function stepName(kind: string): string {
  return STEP_NAMES[kind] ?? kind;
}
