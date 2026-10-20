'use client';

/**
 * A shop customer's sign-in: their mobile number, then the 6-digit code
 * 2Factor texts them (app/api/try/otp). Remembered for 30 days afterwards
 * (components/try/shop.ts), so this shows once a month at most.
 */

import * as React from 'react';
import type { Session } from './shop';

const field = 'block w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none focus:border-slate-900';
const primary = 'w-full rounded-full bg-slate-900 px-5 py-3 text-base font-medium text-white hover:bg-slate-800 disabled:opacity-50';

async function call(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || !json?.success) throw new Error(typeof json?.error === 'string' ? json.error : 'Something went wrong. Please try again.');
  return json;
}

export function SignIn({ source, onSignedIn }: { source: string | null; onSignedIn: (session: Session) => void }) {
  const [phone, setPhone] = React.useState('');
  const [code, setCode] = React.useState('');
  const [consent, setConsent] = React.useState(false);
  const [sent, setSent] = React.useState(false);
  const [wait, setWait] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (wait <= 0) return;
    const timer = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(timer);
  }, [wait]);

  const send = async () => {
    setError(null);
    setBusy(true);
    try {
      const result = await call('/api/try/otp/send', { phone });
      setSent(true);
      setCode('');
      setWait(Number(result.resendAfter) || 30);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setError(null);
    setBusy(true);
    try {
      const result = await call('/api/try/otp/verify', { phone, code, consent, source });
      onSignedIn({ token: String(result.token), phone: String(result.phone) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">{sent ? 'Enter the code' : 'Your mobile number'}</h2>
        <p className="mt-1 text-sm text-slate-500">
          {sent ? `We sent a 6-digit code to +91 ${phone.replace(/\D/g, '').slice(-10)}.` : 'We\'ll text you a code to see your design. You only do this once.'}
        </p>
      </div>

      {!sent ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          className="flex flex-col gap-4"
        >
          <div className="flex items-center gap-2">
            <span className="rounded-xl border border-slate-300 bg-slate-50 px-3 py-3 text-base text-slate-700">+91</span>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/[^\d ]/g, '').slice(0, 12))}
              inputMode="numeric"
              autoComplete="tel-national"
              placeholder="98765 43210"
              aria-label="Mobile number"
              className={field}
              required
            />
          </div>
          <label className="flex items-start gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5" />
            Send me offers and updates from True Tribute by SMS and WhatsApp.
          </label>
          <button type="submit" disabled={busy || phone.replace(/\D/g, '').length < 10} className={primary}>
            {busy ? 'Sending…' : 'Send code'}
          </button>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void verify();
          }}
          className="flex flex-col gap-4"
        >
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="••••••"
            aria-label="6-digit code"
            className={`${field} text-center text-2xl tracking-[0.5em]`}
            autoFocus
            required
          />
          <button type="submit" disabled={busy || code.length !== 6} className={primary}>
            {busy ? 'Checking…' : 'Continue'}
          </button>
          <div className="flex justify-between text-sm">
            <button type="button" onClick={() => setSent(false)} className="text-slate-500 underline-offset-2 hover:underline">
              Change number
            </button>
            <button type="button" disabled={wait > 0 || busy} onClick={() => void send()} className="text-slate-900 underline-offset-2 hover:underline disabled:text-slate-400 disabled:no-underline">
              {wait > 0 ? `Send again in ${wait}s` : 'Send the code again'}
            </button>
          </div>
        </form>
      )}

      {error && (
        <p role="alert" className="text-sm text-rose-600">
          {error}
        </p>
      )}
    </div>
  );
}
