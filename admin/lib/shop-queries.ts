/**
 * The Shopify store's side, as the panel reads it: shop customers and their
 * designs, paid orders and the designs they were made from, and the shop
 * settings (../db/schema.sql). Written by the pendant tool's customer page
 * (app/try) and Shopify's order notification (app/api/shopify).
 */

import { db } from './db';
import { since, type Range } from './queries';

export interface Customer {
  phone: string;
  triesUsed: number;
  triesLimit: number;
  createdAt: string;
  lastSeenAt: string;
  designs: number;
  orders: number;
  marketingConsent: boolean;
  source: string | null;
  codesSent: number;
  /** The last time the team gave this customer designs. */
  given: { detail: string; at: string; by: string } | null;
}

/** Shop customers, the most recently seen first; only those matching `search` (part of a number) when given. */
export async function customers(search: string | null = null): Promise<Customer[]> {
  const digits = search ? search.replace(/\D/g, '') : '';
  const rows = await db()`
    select c.*,
      (select count(*) from generations g where g.phone = c.phone)::int as designs,
      (select count(*) from orders o where o.phone = c.phone)::int as orders,
      (select count(*) from otp_requests r where r.phone = c.phone)::int as codes_sent,
      given.detail as given_detail, given.created_at as given_at, given.by as given_by
    from customers c
    left join lateral (
      select e.detail, e.created_at, u.name as by from events e left join "user" u on u.id = e.user_id
      where e.kind = 'designs_added' and e.phone = c.phone order by e.id desc limit 1
    ) given on true
    where ${digits} = '' or c.phone like ${`%${digits}%`}
    order by c.last_seen_at desc limit 500`;
  return rows.map((r) => ({
    phone: r.phone,
    triesUsed: r.tries_used,
    triesLimit: r.tries_limit,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    designs: r.designs,
    orders: r.orders,
    marketingConsent: r.marketing_consent === true,
    source: r.source,
    codesSent: r.codes_sent,
    given: r.given_at ? { detail: r.given_detail, at: r.given_at, by: r.given_by ?? 'Removed login' } : null,
  }));
}

export interface Order {
  id: string;
  createdAt: string;
  phone: string | null;
  folder: string | null;
  generationId: string | null;
  orderName: string | null;
  product: string | null;
  variant: string | null;
  amount: number;
  currency: string;
}

export async function revenue(range: Range): Promise<{ orders: Order[]; total: number; count: number; fromGenerations: number }> {
  const from = since(range);
  const rows = await db()`select * from orders where created_at >= ${from} order by created_at desc limit 200`;
  const [sum] = await db()`
    select coalesce(sum(amount), 0)::float as total, count(*)::int as count, count(generation_id)::int as from_generations
    from orders where created_at >= ${from}`;
  return {
    orders: rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      phone: r.phone,
      folder: r.folder,
      generationId: r.generation_id,
      orderName: r.order_name,
      product: r.product,
      variant: r.variant,
      amount: Number(r.amount),
      currency: r.currency,
    })),
    total: sum.total,
    count: sum.count,
    fromGenerations: sum.from_generations,
  };
}

export interface ShopSettings {
  supportPhone: string;
  triesLimit: number;
}

export async function shopSettings(): Promise<ShopSettings> {
  const rows = await db()`select key, value from settings where key in ('support_phone', 'tries_limit')`;
  const get = (key: string) => rows.find((r) => r.key === key)?.value ?? '';
  return { supportPhone: get('support_phone'), triesLimit: Number(get('tries_limit')) || 3 };
}

export interface ShopTotals {
  customers: number;
  customerDesigns: number;
  codes: number;
  codeSpendUsd: number;
  orders: number;
}

/** For the dashboard: shop customers who signed in, their designs, the sign-in texts and their cost, and orders. */
export async function shopTotals(range: Range): Promise<ShopTotals> {
  const from = since(range);
  const [row] = await db()`
    select
      (select count(*) from customers where created_at >= ${from})::int as customers,
      (select count(*) from generations where phone is not null and created_at >= ${from})::int as customer_designs,
      (select count(*) from events where kind = 'otp_sent' and created_at >= ${from})::int as codes,
      (select coalesce(sum(cost_usd), 0) from events where kind = 'otp_sent' and created_at >= ${from})::float as code_spend,
      (select count(*) from orders where generation_id is not null and created_at >= ${from})::int as orders`;
  return { customers: row.customers, customerDesigns: row.customer_designs, codes: row.codes, codeSpendUsd: row.code_spend, orders: row.orders };
}

/** The paid orders made from one design. */
export async function ordersOf(generationId: string): Promise<Order[]> {
  const rows = await db()`select * from orders where generation_id = ${generationId} order by created_at`;
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    phone: r.phone,
    folder: r.folder,
    generationId: r.generation_id,
    orderName: r.order_name,
    product: r.product,
    variant: r.variant,
    amount: Number(r.amount),
    currency: r.currency,
  }));
}
