'use client';

/**
 * The customer page and the shop's page around it. The page lives in a frame
 * on shoptruetribute.com (shopify/true-tribute-try.js); the two talk only by
 * postMessage, and only with origins in NEXT_PUBLIC_SHOP_ORIGINS.
 *
 * The sign-in is kept in both places: in this page's own storage, and handed
 * to the shop page to keep in its own, because Safari may clear storage
 * inside a frame. Either one is enough to skip the code next time.
 */

export interface Session {
  token: string;
  phone: string;
}

export interface ShopContext {
  product: { handle: string; title: string } | null;
  variant: { id: string; title: string } | null;
  session: Session | null;
}

const KEY = 'true-tribute:customer';

export const SHOP_ORIGINS = (process.env.NEXT_PUBLIC_SHOP_ORIGINS || 'https://shoptruetribute.com,https://knbbbh-1p.myshopify.com')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

/** The shop page's origin, when this page is in its frame. */
export function parentOrigin(): string | null {
  if (typeof window === 'undefined' || window.parent === window) return null;
  const ancestor = window.location.ancestorOrigins?.[0];
  const referrer = document.referrer ? new URL(document.referrer).origin : null;
  const origin = ancestor ?? referrer;
  return origin && (SHOP_ORIGINS.includes(origin) || origin === window.location.origin) ? origin : null;
}

export function tellShop(message: Record<string, unknown>): void {
  const origin = parentOrigin();
  if (origin) window.parent.postMessage({ source: 'true-tribute', ...message }, origin);
}

export function loadSession(): Session | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    const value = raw ? (JSON.parse(raw) as Partial<Session>) : null;
    return value?.token && value.phone ? { token: value.token, phone: value.phone } : null;
  } catch {
    return null;
  }
}

export function saveSession(session: Session | null): void {
  try {
    if (session) window.localStorage.setItem(KEY, JSON.stringify(session));
    else window.localStorage.removeItem(KEY);
  } catch {
    // The shop page keeps a copy (tellShop 'session').
  }
  tellShop({ type: 'session', session });
}

/** Listens for what the shop page sends: the product, its chosen variant, and a kept sign-in. */
export function onShopMessage(handle: (context: Partial<ShopContext>) => void): () => void {
  const listener = (event: MessageEvent) => {
    if (!(SHOP_ORIGINS.includes(event.origin) || event.origin === window.location.origin)) return;
    const data = event.data as Record<string, unknown> | null;
    if (!data || data.source !== 'true-tribute-shop') return;
    handle({
      product: (data.product as ShopContext['product']) ?? undefined,
      variant: (data.variant as ShopContext['variant']) ?? undefined,
      session: (data.session as ShopContext['session']) ?? undefined,
    });
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
