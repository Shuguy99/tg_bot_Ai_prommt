-- =============================================================================
-- 0002_rls.sql — Row Level Security policies and grants
-- =============================================================================
-- RLS is enabled for every table that can be queried by the client (products,
-- orders, telegram_users). Storage policies are defined here as well.
-- Anonymous users must never read orders or fetch private files directly.
-- =============================================================================

alter table products enable row level security;
alter table orders enable row level security;
alter table telegram_users enable row level security;

-- Default-deny posture. It is explicitly configured for `orders` because even
-- a single overly broad policy can leak purchase history.
alter default privileges revoke all on tables from anon, authenticated;
alter default privileges revoke all on sequences from anon, authenticated;

-- -----------------------------------------------------------------------------
-- products: world-readable for browsing the catalogue, but only active ones
-- -----------------------------------------------------------------------------
-- The Mini App needs to list products to render the shop grid. RLS permits
-- anonymous SELECT for active products only. Draft/inactive products are
-- hidden without any client-side filtering that could be tampered with.
create policy products_read_active
  on products
  for select
  to anon
  using (is_active = true);

-- Service role bypasses RLS, so the admin backend can manage inactive products,
-- edit prices, upload files, etc.

-- -----------------------------------------------------------------------------
-- orders: deny-by-default, with explicit user-scoped policies
-- -----------------------------------------------------------------------------
-- ANON: cannot read orders at all. Even if someone guesses an order id, RLS
-- will block it.
revoke all on table orders from anon;
grant  all on table orders to   service_role;

-- AUTHENTICATED: only for server-side requests coming via the Edge Function or
-- backend that uses a service key? The Telegram Mini App's requests are usually
-- unauthenticated by Supabase Auth. Instead, access is enforced by the backend
-- (which queries with the service role) or by the webhook handlers. However, if
-- you later introduce Supabase Auth with Telegram, use a policy keyed off auth.
-- For now, we explicitly do not grant SELECT/UPDATE to anon and rely on the
-- backend RPCs/functions (service_role bypasses RLS). 
-- If you must allow the client to read its own orders without an app backend,
-- prefer a SECURITY DEFINER function that checks Telegram initData before
-- returning rows.

-- The client-side (anon key) has no access to `orders`. This is intentional
-- to prevent enumeration of other users' purchases.
create policy orders_no_read_anon
  on orders
  for select
  to anon
  using (false);

create policy orders_no_write_anon
  on orders
  for insert
  to anon
  with check (false);

create policy orders_no_update_anon
  on orders
  for update
  to anon
  using (false);

create policy orders_no_delete_anon
  on orders
  for delete
  to anon
  using (false);

-- -----------------------------------------------------------------------------
-- telegram_users: cache only, no public write
-- -----------------------------------------------------------------------------
revoke all on table telegram_users from anon;
grant  all on table telegram_users to   service_role;

create policy telegram_users_anon_read_none
  on telegram_users
  for select
  to anon
  using (false);

create policy telegram_users_anon_write_none
  on telegram_users
  for all
  to anon
  using (false)
  with check (false);

-- -----------------------------------------------------------------------------
-- Storage: product-files bucket (private)
-- -----------------------------------------------------------------------------
-- Remove any default public policies and lock down the bucket.
-- Only the service role (backend functions, migrations scripts run via service
-- key) may manage objects. No anon/authenticated direct access to `product-files`.
revoke all on storage.objects from anon, authenticated;

-- `objects` is owned by `storage`; grant management to service_role only.
grant select, insert, update, delete on storage.objects to service_role;

-- Explicitly block public access via policies (defense in depth even though
-- bucket is private). The `storage.buckets.public=false` already hides objects,
-- but policies must also forbid anon reads.
create policy product_files_anon_select_none
  on storage.objects
  for select
  to anon
  using (bucket_id <> 'product-files');

create policy product_files_anon_all_none
  on storage.objects
  for all
  to anon
  using (bucket_id <> 'product-files')
  with check (bucket_id <> 'product-files');

-- A positive policy for service_role is unnecessary because service_role
-- bypasses RLS, but the above negative posture for anon is clear. If you
-- prefer explicit policies, add a service_role policy scoped to bucket_id='product-files'.
-- Not required here.

-- Notes:
-- - To upload a file: use the Supabase service role key (CI/admin script), not
--   the anon key.
-- - To deliver: mint a signed URL in an Edge Function/webhook handler using
--   `supabase.storage.from('product-files').createSignedUrl(path, 300)` and send
--   it to the buyer via Telegram Bot API. Never expose file_path to the client.
-- - RLS `using` cannot depend on the client supplying user_id unless tied to
--   auth.uid(); with Telegram Mini App, treat the client as untrusted and rely
--   on verified initData + server-side checks.