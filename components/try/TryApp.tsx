'use client';

/**
 * The shop customer's page, in the "Upload your photo" window on a product
 * page of shoptruetribute.com: sign in with a mobile number once, choose gold
 * or silver, upload a photo, watch it being made, and see their pendant as a
 * product photo — only ever the product photo, never the drawing behind it
 * (the shop's wish, 31 Oct). Add to Cart and Buy Now hand it to the shop page, which
 * attaches it to the product form and presses the shop's own button, so the
 * shop's pricing and checkout carry on as usual.
 *
 * The customer may close the window, or browse to other pages, while it is
 * made: it carries on (components/try/pipeline.ts) and the shop page shows a
 * notification when it is ready, which brings them back here.
 *
 * Each phone gets a set number of designs (3). When they are used up the
 * page shows the shop's support number; the admin panel refills them.
 * Everything it makes is saved and shows in the admin panel under the
 * customer's number.
 */

import * as React from 'react';
import { authHeaders, setCustomerToken } from '@/lib/api-auth';
import { metalOf, PICKABLE, SHOP_PRODUCTS, type ShopProduct } from '@/lib/shop-products';
import { SketchError } from '@/lib/sketch-client';
import { Feedback } from './Feedback';
import { dropPhoto, keepPhoto, runDesign, takePhoto, type Metal, type Pending } from './pipeline';
import { Progress, type Stage } from './Progress';
import { SignIn } from './SignIn';
import { loadSession, onShopMessage, saveSession, tellShop, type Session, type ShopContext } from './shop';

interface Me {
  left: number;
  limit: number;
  supportPhone: string;
}

interface Design {
  job: string;
  ref: string;
  createdAt?: string;
  /** Made on this page: the product photo as a data URL. Otherwise it is read through /api/try/image. */
  photo?: string;
  /** False when the product photo could not be made. */
  hasPhoto?: boolean;
  metal?: Metal;
  /** The product page it was made on. */
  handle?: string | null;
  title?: string | null;
  url?: string | null;
}

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 8 * 1024 * 1024;
const primary = 'w-full rounded-full bg-slate-900 px-5 py-3 text-base font-medium text-white hover:bg-slate-800 disabled:opacity-50';
const secondary = 'w-full rounded-full border border-slate-300 bg-white px-5 py-3 text-base font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50';
const STAGE_OF: Record<Pending['step'], Stage> = { drawing: 'inking', photo: 'photo', done: 'done', failed: 'done' };

function withToken(session: Session): Record<string, string> {
  return { Authorization: `Bearer ${session.token}` };
}

function fromPending(p: Pending): Design {
  return { job: String(p.job), ref: p.ref ?? '', hasPhoto: p.photo !== false, metal: p.metal, handle: p.handle, title: p.title, url: p.url };
}

export function TryApp() {
  const [context, setContext] = React.useState<ShopContext>({ product: null, variant: null, session: null, metals: [], url: null, pending: null, worker: false });
  const [session, setSession] = React.useState<Session | null>(null);
  const [me, setMe] = React.useState<Me | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [picked, setPicked] = React.useState<ShopProduct | null>(null);
  const [chosenMetal, setChosenMetal] = React.useState<Metal | null>(null);
  const [stage, setStage] = React.useState<Stage | null>(null);
  const [result, setResult] = React.useState<Design | null>(null);
  const [past, setPast] = React.useState<Design[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  /** "job:metal" of a design whose product photo could not be loaded. */
  const [missing, setMissing] = React.useState<string | null>(null);
  const runRef = React.useRef(0);
  const runningRef = React.useRef<string | null>(null);
  const refreshRef = React.useRef(0);
  const mainRef = React.useRef<HTMLElement>(null);

  const product = (context.product && SHOP_PRODUCTS[context.product.handle]) || picked;
  const metal: Metal = chosenMetal ?? metalOf(context.variant?.title);
  const bothMetals = context.metals.includes('gold') && context.metals.includes('silver');

  const refresh = React.useCallback(async (current: Session | null) => {
    // Only the latest ask counts: one made before signing in must not answer after it.
    const asked = ++refreshRef.current;
    const response = await fetch('/api/try/me', { headers: current ? withToken(current) : {} }).catch(() => null);
    const body = (await response?.json().catch(() => null)) as (Me & { signedIn?: boolean; token?: string }) | null;
    if (asked !== refreshRef.current) return;
    if (current && body?.signedIn === false) {
      // Expired or unknown: sign in again. A failed check (no answer, a server error) is not a sign-out.
      saveSession(null);
      setSession(null);
      setCustomerToken(null);
    }
    // Kept for next time; the token in use stays good, so nothing on the page changes.
    if (current && body?.signedIn && body.token) saveSession({ ...current, token: body.token });
    setMe(body ? { left: body.left ?? 0, limit: body.limit ?? 0, supportPhone: body.supportPhone ?? '' } : null);
    if (current && body?.signedIn) {
      const list = await fetch('/api/try/designs', { headers: withToken(current) }).catch(() => null);
      const designs = ((await list?.json().catch(() => null)) as { designs?: Design[] } | null)?.designs ?? [];
      if (asked === refreshRef.current) setPast(designs);
    }
  }, []);

  // A sign-in kept here or by the shop page; the shop page also sends the product, its variant and any design being made.
  /* eslint-disable react-hooks/set-state-in-effect -- browser-only storage and messages, read after mount */
  React.useEffect(() => {
    const kept = loadSession();
    if (kept) {
      setSession(kept);
      setCustomerToken(kept.token);
    }
    void refresh(kept).finally(() => setLoading(false));
    const stop = onShopMessage((update) => {
      setContext((c) => ({ ...c, ...Object.fromEntries(Object.entries(update).filter(([, v]) => v !== undefined)) }));
      if (update.session && !loadSession()) {
        saveSession(update.session);
        setSession(update.session);
        setCustomerToken(update.session.token);
        void refresh(update.session);
      } else if (update.metals !== undefined) {
        // Sent each time the window is opened: the team may have refilled their designs meanwhile.
        const current = loadSession() ?? update.session;
        if (current) void refresh(current);
      }
    });
    tellShop({ type: 'ready' });
    return stop;
  }, [refresh]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // The window is sized to what is on the page, not a fixed tall box.
  React.useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const observer = new ResizeObserver(() => tellShop({ type: 'size', height: Math.ceil(main.getBoundingClientRect().height) }));
    observer.observe(main);
    return () => observer.disconnect();
  }, []);

  const run = React.useCallback(
    async (start: Pending, file: File | null, current: Session) => {
      const id = ++runRef.current;
      const live = () => id === runRef.current;
      runningRef.current = start.id;
      setError(null);
      setResult(null);
      setStage(STAGE_OF[start.step]);
      // Tells the shop page this page is still at work, so no other page takes it over.
      const beat = setInterval(() => tellShop({ type: 'beat' }), 3000);
      tellShop({ type: 'pending', pending: start });
      try {
        const done = await runDesign(start, file, {
          token: current.token,
          onStage: (next) => {
            if (!live()) return;
            setStage(next);
            // The design is taken when the drawing starts: show it straight away.
            if (next === 'inking') void refresh(current);
          },
          save: (pending) => tellShop({ type: 'pending', pending }),
          cancelled: () => !live(),
        });
        if (!done || !live()) return;
        void dropPhoto(start.id);
        setResult({ ...fromPending(done.pending), photo: done.photo });
        setStage('done');
      } catch (e) {
        if (!live()) return;
        setStage(null);
        const message = e instanceof Error ? e.message : 'Something went wrong. Please try again.';
        tellShop({ type: 'pending', pending: { ...start, step: 'failed', error: message } });
        if (!(e instanceof SketchError && e.outOfTries)) setError(message);
      } finally {
        clearInterval(beat);
        if (live()) runningRef.current = null;
        void refresh(current);
      }
    },
    [refresh],
  );

  // A design the shop page kept: shown if it is ready, carried on if this page is the one to do it.
  /* eslint-disable react-hooks/set-state-in-effect -- follows what the shop page sends */
  React.useEffect(() => {
    const pending = context.pending;
    if (!pending || !session || runningRef.current === pending.id) return;
    if (pending.step === 'done' && pending.job) {
      setResult((r) => (r?.job === pending.job ? r : fromPending(pending)));
      setStage('done');
    } else if (pending.step === 'failed') {
      setStage(null);
      setError(pending.error ?? 'Your design couldn\'t be finished. Please try again.');
    } else if (context.worker) {
      void takePhoto(pending.id).then((file) => run(pending, file, session));
    } else {
      // Being made on another page or tab: shown, not repeated.
      setStage(STAGE_OF[pending.step]);
    }
  }, [context.pending, context.worker, session, run]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const signedIn = (next: Session) => {
    saveSession(next);
    setSession(next);
    setCustomerToken(next.token);
    void refresh(next);
  };

  const signOut = () => {
    saveSession(null);
    setSession(null);
    setCustomerToken(null);
    setResult(null);
    setPast([]);
    void refresh(null);
  };

  const make = async (file: File) => {
    if (!session || !product) return;
    setError(null);
    if (!ACCEPTED.includes(file.type)) return setError('Please choose a JPG, PNG or WEBP photo.');
    if (file.size > MAX_BYTES) return setError('That photo is over 8 MB. Please choose a smaller one.');
    if (context.pending) void dropPhoto(context.pending.id);
    const pending: Pending = {
      id: crypto.randomUUID(),
      product,
      handle: context.product?.handle ?? null,
      title: context.product?.title ?? null,
      url: context.url,
      metal,
      step: 'drawing',
    };
    await keepPhoto(pending.id, file);
    void run(pending, file, session);
  };

  const buy = async (design: Design, then: 'cart' | 'buy') => {
    if (!session) return;
    const chosen = design.metal ?? metal;
    // A link to the design's picture for the cart line, which shows it without the customer's sign-in.
    const answer = await fetch(`/api/try/picture-key?job=${encodeURIComponent(design.job)}`, { headers: authHeaders() })
      .then((r) => (r.ok ? (r.json() as Promise<{ key?: string }>) : null))
      .catch(() => null);
    const picture = answer?.key ? `${location.origin}/api/try/image?job=${encodeURIComponent(design.job)}&kind=photo&metal=${chosen}&key=${answer.key}` : undefined;
    tellShop({ type: 'use-design', job: design.job, ref: design.ref, phone: session.phone, metal: chosen, picture, then });
  };

  const photoOf = (design: Design) =>
    session ? `/api/try/image?job=${encodeURIComponent(design.job)}&kind=photo&metal=${design.metal ?? metal}&token=${encodeURIComponent(session.token)}` : '';

  // A design with no product photo in this metal yet: its photo made now (the drawing is never shown instead).
  const makePhoto = (design: Design) => {
    if (!session || !product) return;
    const pending: Pending = {
      id: crypto.randomUUID(),
      product,
      handle: design.handle ?? context.product?.handle ?? null,
      title: design.title ?? context.product?.title ?? null,
      url: design.url ?? context.url,
      metal: design.metal ?? metal,
      step: 'photo',
      job: design.job,
      ref: design.ref,
    };
    void run(pending, null, session);
  };

  const working = stage !== null && stage !== 'done';
  const noneLeft = Boolean(session && me && me.left <= 0 && !working);
  // A design made for another product: taken back to that product's page to buy.
  const elsewhere = Boolean(result?.handle && context.product && result.handle !== context.product.handle);
  const pickMetal = (
    <fieldset>
      <legend className="mb-2 text-sm font-medium text-slate-700">Gold or silver?</legend>
      <div className="grid grid-cols-2 gap-2">
        {(['gold', 'silver'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setChosenMetal(m)}
            className={`flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium ${metal === m ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 text-slate-700 hover:bg-slate-50'}`}
          >
            <span className={`h-4 w-4 rounded-full border border-black/10 ${m === 'gold' ? 'bg-amber-400' : 'bg-slate-300'}`} />
            {m === 'gold' ? 'Gold' : 'Silver'}
          </button>
        ))}
      </div>
    </fieldset>
  );

  return (
    <main ref={mainRef} className="mx-auto flex w-full max-w-lg flex-col gap-4 bg-white px-4 py-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">See your pendant</h1>
          <p className="text-sm text-slate-500">{context.product?.title ?? result?.title ?? 'True Tribute'}</p>
        </div>
        <button type="button" onClick={() => tellShop({ type: 'close' })} aria-label="Close" className="rounded-full px-2 text-2xl leading-none text-slate-400 hover:text-slate-700">
          ×
        </button>
      </header>

      {loading ? (
        <p className="text-sm text-slate-500">One moment…</p>
      ) : !session ? (
        <SignIn source={context.product?.handle ?? null} onSignedIn={signedIn} />
      ) : (
        <>
          <div className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-2.5 text-sm">
            <span className="text-slate-600">+91 {session.phone.slice(-10)}</span>
            <span className={`font-medium ${me && me.left > 0 ? 'text-slate-900' : 'text-rose-600'}`}>{me ? `${me.left} of ${me.limit} designs left` : ''}</span>
          </div>

          {working && stage && (
            <>
              <Progress key={stage} stage={stage} />
              <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">You can close this and keep browsing. We&apos;ll show a notice at the bottom of the page when your pendant is ready.</p>
            </>
          )}

          {result && !working && (
            <section className="flex flex-col gap-3">
              {!result.photo && (result.hasPhoto === false || missing === `${result.job}:${result.metal ?? metal}`) ? (
                <div className="flex aspect-square w-full flex-col items-center justify-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-6 text-center">
                  <p className="text-sm text-slate-600">The {(result.metal ?? metal) === 'gold' ? 'gold' : 'silver'} photo of this pendant isn&apos;t ready yet.</p>
                  {product && (
                    <button type="button" onClick={() => makePhoto(result)} className={secondary}>
                      Make the pendant photo
                    </button>
                  )}
                </div>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element -- a data URL made here, or the customer's own picture through a signed-in route
                <img
                  src={result.photo ?? photoOf(result)}
                  onError={() => setMissing(`${result.job}:${result.metal ?? metal}`)}
                  alt="Your pendant"
                  className="aspect-square w-full rounded-2xl border border-slate-200 object-contain"
                />
              )}
              {result.ref && (
                <p className="text-center text-sm text-slate-500">
                  Design {result.ref}
                  {result.metal ? ` · ${result.metal === 'gold' ? 'Gold' : 'Silver'}` : ''}
                </p>
              )}
              {elsewhere ? (
                <button type="button" onClick={() => tellShop({ type: 'go', url: result.url })} className={primary}>
                  Go to {result.title ?? 'its product'} to buy it
                </button>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => void buy(result, 'cart')} className={primary}>
                    Add to cart
                  </button>
                  <button type="button" onClick={() => void buy(result, 'buy')} className={secondary}>
                    Buy now
                  </button>
                </div>
              )}
              {result.hasPhoto !== false && <Feedback key={result.job} job={result.job} stage="product_photo" />}
            </section>
          )}

          {!working && !noneLeft && (
            <section className="flex flex-col gap-3">
              {!(context.product && SHOP_PRODUCTS[context.product.handle]) && (
                <fieldset>
                  <legend className="mb-2 text-sm font-medium text-slate-700">Which pendant?</legend>
                  <div className="flex flex-wrap gap-2">
                    {PICKABLE.map((p) => (
                      <button
                        key={p.label}
                        type="button"
                        onClick={() => setPicked(p.product)}
                        className={`rounded-full border px-3 py-1.5 text-sm ${picked === p.product ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 text-slate-700'}`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}
              {bothMetals && pickMetal}
              <label className={`${result ? secondary : primary} cursor-pointer text-center ${product ? '' : 'pointer-events-none opacity-50'}`}>
                {result ? 'Try another photo' : 'Upload your photo'}
                <input
                  type="file"
                  accept={ACCEPTED.join(',')}
                  className="sr-only"
                  disabled={!product}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) void make(file);
                  }}
                />
              </label>
              {!result && <p className="text-center text-xs text-slate-500">A clear photo of the face, or faces, works best. JPG, PNG or WEBP, up to 8 MB.</p>}
            </section>
          )}

          {noneLeft && me && (
            <section className="flex flex-col gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <p className="font-medium">You&apos;ve used all {me.limit} of your designs.</p>
              {me.supportPhone ? (
                <p>
                  Call or WhatsApp us on{' '}
                  <a href={`tel:${me.supportPhone.replace(/\s/g, '')}`} className="font-semibold underline">
                    {me.supportPhone}
                  </a>{' '}
                  and we&apos;ll add more for you.
                </p>
              ) : (
                <p>Please contact us and we&apos;ll add more for you.</p>
              )}
              <p>You can still use any design you&apos;ve already made, below.</p>
            </section>
          )}

          {error && (
            <p role="alert" className="text-sm text-rose-600">
              {error}
            </p>
          )}

          {!working && past.filter((d) => d.job !== result?.job).length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-medium text-slate-700">Your designs</h2>
              <div className="grid grid-cols-3 gap-2">
                {past
                  .filter((d) => d.job !== result?.job)
                  .map((d) => (
                    <button
                      key={d.job}
                      type="button"
                      onClick={() => {
                        setError(null);
                        setResult({ ...d, metal, handle: context.product?.handle ?? null, title: context.product?.title ?? null });
                      }}
                      className="flex flex-col items-center gap-1 rounded-xl border border-slate-200 p-1.5 hover:border-slate-900"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element -- the customer's own picture, through a signed-in route */}
                      <img
                        src={photoOf(d)}
                        onError={(e) => {
                          // No product photo in this metal yet: an empty tile, never the drawing.
                          e.currentTarget.style.visibility = 'hidden';
                        }}
                        alt={`Design ${d.ref}`}
                        loading="lazy"
                        className="aspect-square w-full rounded-lg bg-slate-50 object-contain"
                      />
                      <span className="text-[11px] text-slate-500">{d.ref}</span>
                    </button>
                  ))}
              </div>
            </section>
          )}

          <button type="button" onClick={signOut} className="self-center text-xs text-slate-400 underline-offset-2 hover:underline">
            Not you? Use another number
          </button>
        </>
      )}
    </main>
  );
}
