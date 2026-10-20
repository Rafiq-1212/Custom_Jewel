'use client';

/**
 * The shop customer's page, in the "Upload your photo" window on a product
 * page of shoptruetribute.com: sign in with a mobile number once, upload a
 * photo, watch it being made, and see their pendant as a product photo in
 * the metal they chose. "Use this design" hands it to the shop page, which
 * attaches it to the product form; the customer then buys as usual.
 *
 * Each phone gets a set number of designs (3). When they are used up the
 * page shows the shop's support number; the admin panel refills them.
 * Everything it makes is saved and shows in the admin panel under the
 * customer's number.
 */

import * as React from 'react';
import { setCustomerToken } from '@/lib/api-auth';
import { designRef } from '@/lib/design-ref';
import { extractSilhouetteContour } from '@/lib/edge-cut-contour';
import { runMockup } from '@/lib/mockup-client';
import { PENDANT_CATEGORIES } from '@/lib/pendant-categories';
import { DEFAULT_TRANSFORM, PENDANT_SHAPES } from '@/lib/pendant-shapes';
import { metalOf, PICKABLE, SHOP_PRODUCTS, type ShopProduct } from '@/lib/shop-products';
import { runSketch, SketchError } from '@/lib/sketch-client';
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
  photo?: string;
  sketch?: string;
}

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 8 * 1024 * 1024;
const primary = 'w-full rounded-full bg-slate-900 px-5 py-3 text-base font-medium text-white hover:bg-slate-800 disabled:opacity-50';
const secondary = 'w-full rounded-full border border-slate-300 bg-white px-5 py-3 text-base font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50';

function withToken(session: Session): Record<string, string> {
  return { Authorization: `Bearer ${session.token}` };
}

export function TryApp() {
  const [context, setContext] = React.useState<ShopContext>({ product: null, variant: null, session: null });
  const [session, setSession] = React.useState<Session | null>(null);
  const [me, setMe] = React.useState<Me | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [picked, setPicked] = React.useState<ShopProduct | null>(null);
  const [stage, setStage] = React.useState<Stage | null>(null);
  const [result, setResult] = React.useState<Design | null>(null);
  const [past, setPast] = React.useState<Design[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const runRef = React.useRef(0);

  const product = (context.product && SHOP_PRODUCTS[context.product.handle]) || picked;
  const metal = metalOf(context.variant?.title);

  const refresh = React.useCallback(async (current: Session | null) => {
    const response = await fetch('/api/try/me', { headers: current ? withToken(current) : {} }).catch(() => null);
    const body = (await response?.json().catch(() => null)) as (Me & { signedIn?: boolean }) | null;
    if (current && !body?.signedIn) {
      // Expired or unknown: sign in again.
      saveSession(null);
      setSession(null);
      setCustomerToken(null);
    }
    setMe(body ? { left: body.left ?? 0, limit: body.limit ?? 0, supportPhone: body.supportPhone ?? '' } : null);
    if (current && body?.signedIn) {
      const list = await fetch('/api/try/designs', { headers: withToken(current) }).catch(() => null);
      const designs = ((await list?.json().catch(() => null)) as { designs?: Design[] } | null)?.designs ?? [];
      setPast(designs);
    }
  }, []);

  // A sign-in kept here or by the shop page; the shop page also sends the product and its variant.
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
      }
    });
    tellShop({ type: 'ready' });
    return stop;
  }, [refresh]);
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
    const run = ++runRef.current;
    const live = () => run === runRef.current;
    setResult(null);
    setStage('uploading');
    try {
      const sketch = await runSketch({
        file,
        category: product.category,
        onStage: (next) => {
          if (!live()) return;
          setStage(next);
          // The design is taken when the drawing starts: show it straight away.
          if (next === 'inking') void refresh(session);
        },
        cancelled: () => !live(),
      });
      if (!sketch || !live()) return;
      setStage('photo');
      // The pendant as the shop sells it: its cut outline traced from the drawing, in the chosen metal.
      const needsOutline = product.designType === 'edge-cut' || Boolean(PENDANT_SHAPES[product.shape].frame);
      const contour = needsOutline ? await extractSilhouetteContour(sketch.image, { sealEdges: product.category !== 'face' }) : null;
      const photo = await runMockup({
        sketch: sketch.image,
        shape: product.shape,
        material: metal,
        transform: DEFAULT_TRANSFORM,
        engravingArea: PENDANT_CATEGORIES[product.category].engravingArea,
        designType: product.designType,
        contour,
        rimColor: 'none',
        category: product.category,
      }).catch(() => null);
      if (!live()) return;
      const list = await fetch('/api/try/designs', { headers: withToken(session) }).catch(() => null);
      const designs = ((await list?.json().catch(() => null)) as { designs?: Design[] } | null)?.designs ?? [];
      const ref = designRef(sketch.folder) || (designs.find((d) => d.job === sketch.job)?.ref ?? '');
      setResult({ job: sketch.job, ref, photo: photo ?? undefined, sketch: sketch.image });
      setPast(designs);
      setStage('done');
      void refresh(session);
    } catch (e) {
      if (!live()) return;
      setStage(null);
      if (e instanceof SketchError && e.outOfTries) {
        void refresh(session);
        return;
      }
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
      void refresh(session);
    }
  };

  const use = (design: Design) => {
    if (!session) return;
    tellShop({ type: 'use-design', job: design.job, ref: design.ref, phone: session.phone });
  };

  const imageOf = (design: Design, kind: 'photo' | 'sketch') =>
    session ? `/api/try/image?job=${encodeURIComponent(design.job)}&kind=${kind}&metal=${metal}&token=${encodeURIComponent(session.token)}` : '';

  const working = stage !== null && stage !== 'done';
  const noneLeft = Boolean(session && me && me.left <= 0 && !working);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-5 bg-white px-5 py-6">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">See your pendant</h1>
          <p className="text-sm text-slate-500">{context.product?.title ?? 'True Tribute'}</p>
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
            <span className={`font-medium ${me && me.left > 0 ? 'text-slate-900' : 'text-rose-600'}`}>
              {me ? `${me.left} of ${me.limit} designs left` : ''}
            </span>
          </div>

          {working && stage && <Progress key={stage} stage={stage} />}

          {result && !working && (
            <section className="flex flex-col gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element -- a data URL made here */}
              <img src={result.photo ?? result.sketch} alt="Your pendant" className="aspect-square w-full rounded-2xl border border-slate-200 object-contain" />
              {!result.photo && <p className="text-xs text-slate-500">The product photo couldn&apos;t be made just now; this is your design&apos;s drawing.</p>}
              {result.ref && <p className="text-center text-sm text-slate-500">Design {result.ref}</p>}
              <button type="button" onClick={() => use(result)} className={primary}>
                Use this design
              </button>
              <p className="text-center text-xs text-slate-500">Then choose Add to Cart or Buy Now on the page, as usual.</p>
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
                    <button key={d.job} type="button" onClick={() => use(d)} className="flex flex-col items-center gap-1 rounded-xl border border-slate-200 p-1.5 hover:border-slate-900">
                      {/* eslint-disable-next-line @next/next/no-img-element -- the customer's own picture, through a signed-in route */}
                      <img
                        src={imageOf(d, 'photo')}
                        onError={(e) => {
                          const img = e.currentTarget;
                          if (!img.dataset.fallback) {
                            img.dataset.fallback = '1';
                            img.src = imageOf(d, 'sketch');
                          }
                        }}
                        alt={`Design ${d.ref}`}
                        loading="lazy"
                        className="aspect-square w-full rounded-lg object-contain"
                      />
                      <span className="text-[11px] text-slate-500">Use {d.ref}</span>
                    </button>
                  ))}
              </div>
            </section>
          )}

          <button type="button" onClick={signOut} className="mt-auto self-center text-xs text-slate-400 underline-offset-2 hover:underline">
            Not you? Use another number
          </button>
        </>
      )}
    </main>
  );
}
