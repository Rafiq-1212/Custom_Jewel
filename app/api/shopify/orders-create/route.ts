/**
 * POST /api/shopify/orders-create — Shopify's "Order creation" notification.
 *
 * Set up in the store's admin (Settings → Notifications → Webhooks: Order
 * creation, JSON, this address); the signing secret Shopify shows there is
 * SHOPIFY_WEBHOOK_SECRET. Every request is checked against it.
 *
 * Each line that carries a design from the customer page (the hidden
 * `_tt_design` property, added by the theme's "Upload your photo") is saved
 * as an order of that design, with the customer's phone: the admin panel's
 * Revenue and Customers read it. Saving twice is harmless, so Shopify's
 * retries are too.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { normalisePhone } from '@/lib/otp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const JOB_NAME = /^batches\/[A-Za-z0-9_-]{1,128}$/;

interface LineItem {
  id?: number | string;
  title?: string;
  variant_title?: string | null;
  price?: string;
  quantity?: number;
  properties?: { name?: string; value?: string }[] | Record<string, string> | null;
}

function propertiesOf(line: LineItem): Record<string, string> {
  const raw = line.properties;
  if (Array.isArray(raw)) return Object.fromEntries(raw.filter((p) => p?.name).map((p) => [String(p.name), String(p.value ?? '')]));
  return raw && typeof raw === 'object' ? (raw as Record<string, string>) : {};
}

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret || !process.env.DATABASE_URL) return new Response('Not set up', { status: 503 });
  const raw = await request.text();
  const expected = Buffer.from(createHmac('sha256', secret).update(raw, 'utf8').digest('base64'));
  const given = Buffer.from(request.headers.get('x-shopify-hmac-sha256') ?? '');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return new Response('Unauthorized', { status: 401 });

  const order = JSON.parse(raw) as {
    id?: number | string;
    name?: string;
    currency?: string;
    created_at?: string;
    phone?: string | null;
    customer?: { phone?: string | null } | null;
    shipping_address?: { phone?: string | null } | null;
    line_items?: LineItem[];
  };
  const sql = neon(process.env.DATABASE_URL);
  const orderPhone = normalisePhone(order.phone ?? order.customer?.phone ?? order.shipping_address?.phone ?? '');
  let saved = 0;
  for (const line of order.line_items ?? []) {
    const props = propertiesOf(line);
    const job = props._tt_design;
    if (!job || !JOB_NAME.test(job)) continue;
    const phone = normalisePhone(props._tt_phone ?? '') ?? orderPhone;
    const amount = Number(line.price ?? 0) * Number(line.quantity ?? 1);
    await sql`
      insert into orders (id, created_at, phone, folder, amount, currency, generation_id, order_name, product, variant)
      values (${`${order.id}:${line.id}`}, ${order.created_at ?? new Date().toISOString()}, ${phone},
              (select folder from generations where id = ${job}), ${amount}, ${order.currency ?? 'INR'}, ${job},
              ${order.name ?? null}, ${line.title ?? null}, ${line.variant_title ?? null})
      on conflict (id) do update set phone = excluded.phone, amount = excluded.amount, order_name = excluded.order_name`;
    saved++;
  }
  console.info(`[shopify] order ${order.name ?? order.id}: ${saved} designed line(s) saved`);
  return new Response('ok');
}
