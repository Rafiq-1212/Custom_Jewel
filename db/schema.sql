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

-- Who made it: the team member's admin login ("user".id). Empty for what
-- was made before the tool needed a login.
alter table generations add column if not exists created_by text;
alter table events add column if not exists user_id text;
create index if not exists generations_created_by on generations (created_by);

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

-- Feedback on what the tool made: a sketch, a product photo, or a set of
-- production files. Given by the team in the tool, read and worked through
-- in the admin panel's Feedback screen.
create table if not exists feedback (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  generation_id text,          -- the design it is about
  stage text not null,         -- sketch | product_photo | production_files
  rating text not null,        -- good | bad
  issues text[] not null default '{}',        -- what was wrong, by key (lib/feedback.ts)
  issue_labels text[] not null default '{}',  -- the same, as the person read them
  person text,                 -- which person in the photo: left | middle | right | all
  note text,                   -- in their own words
  user_id text,                -- who gave it ("user".id)
  redraw_job text,             -- the drawing made from it, if one was
  status text not null default 'open',        -- open | fixed
  resolved_at timestamptz,
  resolved_by text,
  resolution text              -- what was changed to fix it
);
create index if not exists feedback_created_at on feedback (created_at desc);
-- A shop customer's own feedback on their design: their number instead of a login.
alter table feedback add column if not exists phone text;
create index if not exists feedback_generation on feedback (generation_id);

-- A drawing redone from feedback points at the drawing it corrects, and keeps
-- the corrections it was given (they carry on into a redraw of a redraw).
alter table generations add column if not exists parent_id text;
alter table generations add column if not exists corrections text;

-- Shop customers (the Shopify store's "Upload your photo"): who they are,
-- where they came from, and whether they agreed to hear from the shop.
-- tries_used counts designs made, against tries_limit (3); the admin panel
-- refills them.
alter table customers add column if not exists marketing_consent boolean not null default false;
alter table customers add column if not exists consent_at timestamptz;
alter table customers add column if not exists consent_text text;
alter table customers add column if not exists source text;          -- the product they first came from

-- One row per sign-in code sent. The code itself is never stored, only a keyed hash of it.
create table if not exists otp_requests (
  id bigserial primary key,
  phone text not null,                  -- +91XXXXXXXXXX
  code_hash text not null,
  ip text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  attempts integer not null default 0,
  consumed_at timestamptz
);
create index if not exists otp_requests_phone_created on otp_requests (phone, created_at desc);
create index if not exists otp_requests_ip_created on otp_requests (ip, created_at desc);

-- Who a ledger line is for, when it was a shop customer rather than the team.
alter table events add column if not exists phone text;

-- A paid order's line, linked to the design it was made from.
alter table orders add column if not exists generation_id text;
alter table orders add column if not exists order_name text;      -- e.g. #1042
alter table orders add column if not exists product text;
alter table orders add column if not exists variant text;
create index if not exists orders_generation on orders (generation_id);

-- Shop settings the admin panel can change without a deploy: the support
-- number shown when a customer has used their designs, and how many designs
-- a new customer gets.
create table if not exists settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
insert into settings (key, value) values ('support_phone', '') on conflict (key) do nothing;
insert into settings (key, value) values ('tries_limit', '3') on conflict (key) do nothing;
