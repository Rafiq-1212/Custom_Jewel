-- The record of what the pendant tool has made and what it cost, shared by
-- the tool (which writes it, lib/tracking.ts) and the admin app (which reads
-- it, admin/). Applied with `node db/apply.mjs`; every statement is safe to
-- run again.

-- One row per person who generates, keyed by phone number. Filled in once
-- customers sign in from the Shopify store; the admin resets `tries_used`.
create table if not exists customers (
  phone text primary key,
  tries_used integer not null default 0,
  tries_limit integer not null default 3,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- One row per sketch that was started: a photo that went in.
create table if not exists generations (
  id text primary key,                      -- the drawing job's name
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  phone text,                               -- null until customers sign in
  category text not null,
  status text not null default 'running',   -- running | done | failed
  folder text,                              -- orders/<day>/<id> in the image store, once the sketch exists
  error text
);
create index if not exists generations_created_at on generations (created_at desc);
create index if not exists generations_folder on generations (folder);
create index if not exists generations_phone on generations (phone);

-- The ledger: every step that ran, what it cost, and the file it saved.
create table if not exists events (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  kind text not null,          -- sketch_start | sketch_done | sketch_redo | sketch_failed | product_photo | production_files
  generation_id text,          -- for the sketch steps
  folder text,                 -- the order it belongs to, when known
  detail text,                 -- category, metal, or the error
  cost_usd numeric(10, 4) not null default 0,
  file text                    -- path in the image store
);
create index if not exists events_created_at on events (created_at desc);
create index if not exists events_folder on events (folder);

-- Paid orders, from the Shopify store (not connected yet).
create table if not exists orders (
  id text primary key,         -- the shop's order id
  created_at timestamptz not null default now(),
  phone text,
  folder text,                 -- the generation that was bought, when the shop passes it on
  amount numeric(12, 2) not null,
  currency text not null default 'INR'
);
create index if not exists orders_created_at on orders (created_at desc);
