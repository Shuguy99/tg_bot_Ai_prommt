import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let cached: SupabaseClient | null = null

/**
 * Service-role client. Bypasses RLS, so every caller must have already
 * authenticated the request (verified Telegram initData) and validated inputs.
 *
 * Never import this from anything that ships to the browser.
 */
export function getAdminClient(): SupabaseClient {
  if (cached) return cached

  const url = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !serviceRoleKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  }

  cached = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  return cached
}

export interface ProductRow {
  id: string
  title: string
  description: string | null
  price: string
  stars_price: number | null
  file_path: string
  is_active: boolean
}

export interface OrderRow {
  id: string
  user_id: number
  product_id: string
  amount: string
  currency: string
  gateway: 'yookassa' | 'telegram_stars'
  status: 'pending' | 'paid' | 'delivered' | 'failed' | 'refunded'
  provider_payment_id: string | null
  idempotency_key: string | null
  paid_at: string | null
  delivered_at: string | null
  failure_reason: string | null
  created_at: string
}

/**
 * Loads a product for purchase. Returns null for inactive products so a
 * de-listed product cannot be bought via a hand-crafted request.
 */
export async function loadPurchasableProduct(productId: string): Promise<ProductRow | null> {
  const { data, error } = await getAdminClient()
    .from('products')
    .select('id, title, description, price, stars_price, file_path, is_active')
    .eq('id', productId)
    .eq('is_active', true)
    .maybeSingle<ProductRow>()

  if (error) throw new Error(`products lookup failed: ${error.message}`)
  return data ?? null
}

/**
 * Loads a product ignoring `is_active`.
 *
 * Used by the delivery path only: a product deactivated *after* the buyer paid
 * must still be delivered, otherwise the customer loses their money over an
 * unrelated admin action.
 */
export async function loadProductById(productId: string): Promise<ProductRow | null> {
  const { data, error } = await getAdminClient()
    .from('products')
    .select('id, title, description, price, stars_price, file_path, is_active')
    .eq('id', productId)
    .maybeSingle<ProductRow>()

  if (error) throw new Error(`products lookup failed: ${error.message}`)
  return data ?? null
}

export async function loadOrderById(orderId: string): Promise<OrderRow | null> {
  const { data, error } = await getAdminClient()
    .from('orders')
    .select('*')
    .eq('id', orderId)
    .maybeSingle<OrderRow>()

  if (error) throw new Error(`order lookup failed: ${error.message}`)
  return data ?? null
}

/**
 * Creates the order row in `pending`.
 *
 * The unique index on (user_id, product_id, gateway, idempotency_key) absorbs
 * retries: a second insert with the same key raises 23505, and we return the
 * existing order instead of failing. The caller then re-runs the gateway call
 * with the same idempotency key, which YooKassa resolves to the same payment
 * rather than charging twice.
 *
 * A retry is only served while the order is still `pending`; once it is settled
 * a fresh key is required, which is the correct behaviour.
 */
export async function createOrder(args: {
  userId: number
  productId: string
  amount: string
  currency: 'RUB' | 'XTR'
  gateway: 'yookassa' | 'telegram_stars'
  idempotencyKey: string
}): Promise<OrderRow> {
  const admin = getAdminClient()

  const { data, error } = await admin
    .from('orders')
    .insert({
      user_id: args.userId,
      product_id: args.productId,
      amount: args.amount,
      currency: args.currency,
      gateway: args.gateway,
      status: 'pending',
      idempotency_key: args.idempotencyKey,
    })
    .select()
    .single<OrderRow>()

  if (!error) return data

  if (error.code !== '23505') {
    throw new Error(`order insert failed: ${error.message}`)
  }

  // Unique violation: this exact request already created an order.
  const { data: existing, error: lookupError } = await admin
    .from('orders')
    .select('*')
    .eq('user_id', args.userId)
    .eq('product_id', args.productId)
    .eq('gateway', args.gateway)
    .eq('idempotency_key', args.idempotencyKey)
    .eq('status', 'pending')
    .maybeSingle<OrderRow>()

  if (lookupError || !existing) {
    throw new Error(`order insert failed: ${error.message}`)
  }

  return existing
}

/**
 * Atomically moves a pending order to `paid`, but only if the provider
 * reference matches.
 *
 * The `status = 'pending'` guard is the idempotency barrier: a replayed webhook
 * or a duplicated Stars payment updates 0 rows and is silently discarded, so the
 * file is delivered exactly once.
 *
 * Returns the updated row, or null if the order was already settled.
 */
export async function markOrderPaid(args: {
  orderId: string
  providerPaymentId: string
}): Promise<OrderRow | null> {
  const { data, error } = await getAdminClient()
    .from('orders')
    .update({
      status: 'paid',
      provider_payment_id: args.providerPaymentId,
      paid_at: new Date().toISOString(),
    })
    .eq('id', args.orderId)
    .eq('status', 'pending')
    .eq('provider_payment_id', args.providerPaymentId)
    .select()
    .maybeSingle<OrderRow>()

  if (error) throw new Error(`mark paid failed: ${error.message}`)
  return data ?? null
}

export async function markOrderFailed(
  orderId: string,
  reason: string,
): Promise<void> {
  await getAdminClient()
    .from('orders')
    .update({ status: 'failed', failure_reason: reason.slice(0, 500) })
    .eq('id', orderId)
    .eq('status', 'pending')
}

/**
 * Fails a pending YooKassa order identified by its payment id.
 *
 * Guarded on status='pending' so a late cancellation notice cannot overwrite an
 * order that already succeeded and was delivered.
 */
export async function markOrderFailedByProviderPaymentId(
  providerPaymentId: string,
  reason: string,
): Promise<void> {
  await getAdminClient()
    .from('orders')
    .update({ status: 'failed', failure_reason: reason.slice(0, 500) })
    .eq('gateway', 'yookassa')
    .eq('provider_payment_id', providerPaymentId)
    .eq('status', 'pending')
}

/** Marks delivery done. Guarded the same way as markOrderPaid. */
export async function markOrderDelivered(orderId: string): Promise<void> {
  await getAdminClient()
    .from('orders')
    .update({ status: 'delivered', delivered_at: new Date().toISOString() })
    .eq('id', orderId)
    .in('status', ['paid', 'delivered'])
}

/**
 * Mints a short-lived signed URL for the purchased file.
 *
 * The bucket is private, so this is the only path from "order is paid" to "user
 * can download the bytes".
 */
export async function createSignedDownloadUrl(filePath: string): Promise<string> {
  const { data, error } = await getAdminClient()
    .storage.from('product-files')
    .createSignedUrl(filePath, 3600, { download: true })

  if (error || !data?.signedUrl) {
    throw new Error(`signed url failed for ${filePath}: ${error?.message ?? 'unknown'}`)
  }
  return data.signedUrl
}

export async function upsertTelegramUser(user: {
  id: number
  username?: string
  first_name?: string
  language_code?: string
}): Promise<void> {
  await getAdminClient().from('telegram_users').upsert({
    user_id: user.id,
    username: user.username ?? null,
    first_name: user.first_name ?? null,
    language_code: user.language_code ?? null,
    last_seen_at: new Date().toISOString(),
  })
}