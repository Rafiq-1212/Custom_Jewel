/**
 * What each design actually costs in API spend.
 *
 * Every Gemini call already logged its token counts; this turns those counts
 * into money and adds them up per request, so the server log carries one line
 * per sketch and one per product photo:
 *
 *   [cost] sketch face/final: 3 calls $0.2268 = ₹21.73 — touch-up 1K $0.0687,
 *          face check $0.0019, finish 4K $0.1544
 *
 * That line is the whole point: a shop that sees "₹120 an image" needs to
 * know whether that is one expensive call or five cheap ones repeated. The
 * cost of a request is not the cost of a piece — a redraw or a second product
 * photo is another line — so the lines are labelled and countable.
 *
 * Prices are Google's list prices for the two models this app uses, read from
 * https://ai.google.dev/gemini-api/docs/pricing (September 2026). They are
 * constants here rather than a live lookup on purpose: a log line that is
 * wrong by a known, fixed amount is worth far more than one that silently
 * depends on a network call. Update them when Google does — note the text
 * model's own price doubles on 1 January 2027.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

if (typeof window !== 'undefined') {
  throw new Error('lib/cost.ts was imported into a browser bundle. This module is server-only.');
}

/** US dollars per 1M tokens. */
const IMAGE_MODEL = {
  input: 0.5,
  /** Text and thinking that comes back alongside the picture. */
  outputText: 3,
  /** The big one: 93% of what this app spends is here. */
  outputImage: 60,
};
/** US dollars per 1M tokens, gemini-3.6-flash, until 31 December 2026. */
const TEXT_MODEL = {
  input: 0.75,
  output: 3.75,
};

/**
 * Only for the rupee figure in the log line, so the number reads the way the
 * shop thinks about it. Set INR_PER_USD in the environment to keep it
 * current; the dollar figure beside it is the one that is exact.
 */
const DEFAULT_INR_PER_USD = 95.8;

function inrPerUsd(): number {
  const configured = Number(process.env.INR_PER_USD);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_INR_PER_USD;
}

/** What the SDK reports back; only the fields this file needs. */
export interface CallUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  candidatesTokensDetails?: { modality?: string; tokenCount?: number }[];
}

/**
 * An image call. Output tokens are billed at two different rates, and which
 * is which is only visible in the per-modality breakdown, so the image tokens
 * are taken from there and everything else counts as text.
 */
export function priceImageCall(usage: CallUsage): number {
  const imageTokens = (usage.candidatesTokensDetails ?? [])
    .filter((detail) => detail.modality === 'IMAGE')
    .reduce((total, detail) => total + (detail.tokenCount ?? 0), 0);
  const textTokens = Math.max(0, (usage.candidatesTokenCount ?? 0) - imageTokens) + (usage.thoughtsTokenCount ?? 0);
  return (
    ((usage.promptTokenCount ?? 0) * IMAGE_MODEL.input +
      imageTokens * IMAGE_MODEL.outputImage +
      textTokens * IMAGE_MODEL.outputText) /
    1e6
  );
}

/** A text call: the bindi check and the jawline lookup. Fractions of a cent. */
export function priceTextCall(usage: CallUsage): number {
  const output = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
  return ((usage.promptTokenCount ?? 0) * TEXT_MODEL.input + output * TEXT_MODEL.output) / 1e6;
}

interface Tally {
  label: string;
  calls: { name: string; usd: number }[];
  /** What was NOT spent because something was reused. */
  saved: number;
}

/**
 * Async context rather than a parameter threaded through every function: the
 * call sites that spend the money (lib/gemini.ts) are four layers below the
 * route that wants the total, and passing a ledger through all of them would
 * change every signature in between to serve the log.
 */
const tally = new AsyncLocalStorage<Tally>();

/** Called by lib/gemini.ts after each call, whether or not anyone is counting. */
export function recordCall(name: string, usd: number): void {
  tally.getStore()?.calls.push({ name, usd });
}

/** Called when a cached result stands in for a call that would have been made. */
export function recordSaving(name: string, usd: number): void {
  const store = tally.getStore();
  if (!store) return;
  store.saved += usd;
  console.info(`[cost] reused ${name}, saving $${usd.toFixed(4)}`);
}

function money(usd: number): string {
  return `$${usd.toFixed(4)} = ₹${(usd * inrPerUsd()).toFixed(2)}`;
}

/**
 * Runs `work` with a fresh ledger and logs the total afterwards, whether it
 * succeeded or not — a request that fails after two calls still spent the
 * money for those two calls, and that is exactly the case worth seeing.
 */
export async function withCostLog<T>(label: string, work: () => Promise<T>): Promise<T> {
  const store: Tally = { label, calls: [], saved: 0 };
  try {
    return await tally.run(store, work);
  } finally {
    const total = store.calls.reduce((sum, call) => sum + call.usd, 0);
    const breakdown = store.calls.map((call) => `${call.name} $${call.usd.toFixed(4)}`).join(', ');
    const saved = store.saved > 0 ? `, saved ${money(store.saved)} by reusing earlier work` : '';
    console.info(
      `[cost] ${label}: ${store.calls.length} call${store.calls.length === 1 ? '' : 's'} ${money(total)}${saved}${breakdown ? ` — ${breakdown}` : ''}`,
    );
  }
}

/**
 * List prices for a whole call, used to say what a cache hit saved without
 * having made the call. Measured token counts on real photographs, so they
 * are what these steps actually cost rather than a guess: the touch-up and
 * the product photo return a 1K image, the finish a 2K or 4K one.
 */
export const TYPICAL_COST = {
  touchUp: 0.0687,
  faceCheck: 0.0019,
  jawline: 0.0018,
  finish2K: 0.1039,
  finish4K: 0.1544,
  mockup: 0.0686,
};
