-- =============================================================================
-- 0001_schema.sql — core schema for the digital-file shop TMA
-- =============================================================================
-- Run with:  supabase db push      (or paste into Supabase Studio -> SQL editor)
-- =============================================================================

create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
-- `gateway` and `status` are enums rather than free text so that an invalid
-- value cannot reach the database even if a future code path forgets to check.
create type order_gateway as enum ('yookassa', 'telegram_stars');

create type order_status as enum (
  'pending',   -- order row created, waiting for the gateway to confirm
  'paid',      -- money confirmed by the gateway
  'delivered', -- paid AND the file was successfully sent to the user
  'failed',    -- gateway reported a terminal failure (canceled/closed/declined)
  'refunded'   -- money returned to the buyer
);

-- -----------------------------------------------------------------------------
-- products
-- -----------------------------------------------------------------------------
create table products (
  id          uuid primary key default gen_random_uuid(),
  title       text        not null check (length(title) between 1 and 200),
  description text,

  -- RUB price. `numeric` (not float) so money is never rounded by binary
  -- floating point. Mirrors the price column YooKassa expects.
  price       numeric(10, 2) not null check (price > 0),

  -- Price in Telegram Stars, as a whole number of stars.
  -- Deliberately NOT derived from `price`: the RUB/Star rate moves over time and
  -- must be set manually per product to hit a target margin. NULL means the
  -- product is not offered through the Stars gateway.
  stars_price integer check (stars_price > 0),

  -- Path inside the private `product-files` bucket, e.g.
  -- 'course-2026/lesson-1.zip'. Never a public URL: the browser must not be
  -- able to fetch this without going through the paid-orders flow.
  file_path   text        not null,

  is_active   boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- A product must be purchasable through at least one gateway, otherwise the
  -- shop renders a buy button that can only fail.
  constraint products_needs_a_price check (price > 0 or stars_price > 0)
);

comment on column products.file_path is
  'Object key in the private product-files bucket. Resolved to a short-lived signed URL only at fulfilment time.';

-- -----------------------------------------------------------------------------
-- orders
-- -----------------------------------------------------------------------------
create table orders (
  id          uuid primary key default gen_random_uuid(),

  -- Telegram user id. `bigint` because Telegram ids exceed int4 for large ids.
  user_id     bigint      not null check (user_id > 0),
  product_id  uuid        not null references products (id) on delete restrict,

  -- Amount actually charged, snapshotted at order creation. Storing it (rather
  -- than reading products.price later) keeps the order history correct if the
  -- price is edited between purchase and fulfilment.
  amount      numeric(10, 2) not null check (amount > 0),
  currency    text         not null check (currency in ('RUB', 'XTR')),

  gateway     order_gateway not null,
  status      order_status   not null default 'pending',

  -- Gateway-side identifier: YooKassa payment id, or the Stars telegram_payment_charge_id.
  provider_payment_id text,

  -- Prevents double-charging when the client retries a payment request after a
  -- network timeout. Unique per gateway+user.
  idempotency_key text,

  paid_at       timestamptz,
  delivered_at  timestamptz,
  failure_reason text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Stars are always a whole number, and Stars payments have no fractional
  -- part at all. RUB amounts may legitimately have kopecks (490.50).
  constraint orders_xtr_amount_is_integer check (
    currency <> 'XTR' or amount = trunc(amount)
  )
);

comment on column orders.amount is
  'Snapshot of the charged amount, not a live read of products.price.';

-- One successful provider payment may fulfil exactly one order.
create unique index orders_provider_payment_id_uniq
  on orders (gateway, provider_payment_id)
  where provider_payment_id is not null;

-- Replay protection: the same (user, product, idempotency key) must not produce
-- two orders, so a client retry cannot charge the card twice.
create unique index orders_idempotency_uniq
  on orders (user_id, product_id, gateway, idempotency_key)
  where idempotency_key is not null;

-- Lookup paths used by the app: "my purchases" and webhook resolution.
create index orders_user_created_idx   on orders (user_id, created_at desc);
create index orders_product_id_idx     on orders (product_id);
create index orders_pending_idx        on orders (status)
  where status = 'pending';

-- -----------------------------------------------------------------------------
-- telegram_users — lightweight profile cache
-- -----------------------------------------------------------------------------
-- Not strictly required to sell files, but it keeps the webhook handlers from
-- trusting free-form names/usernames supplied by the client.
create table telegram_users (
  user_id      bigint primary key check (user_id > 0),
  username     text,
  first_name   text,
  language_code text,
  last_seen_at timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- trigger: keep updated_at honest
-- -----------------------------------------------------------------------------
create or replace function touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger products_touch_updated_at
  before update on products
  for each row execute function touch_updated_at();

create trigger orders_touch_updated_at
  before update on orders
  for each row execute function touch_updated_at();

-- -----------------------------------------------------------------------------
-- Private storage bucket for the sold files
-- -----------------------------------------------------------------------------
-- `public = false` is the whole point: no object in this bucket is reachable
-- without a signed URL minted server-side after a paid order is confirmed.
insert into storage.buckets (id, name, public, file_size_limit)
values ('product-files', 'product-files', false, 524288000) -- 500 MB
on conflict (id) do nothing;

-- Files are uploaded by an admin/service account, never by the Mini App
-- browser. The anon role gets no storage policies at all (see 0002_rls.sql).