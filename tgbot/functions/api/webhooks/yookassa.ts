/**
 * YooKassa webhook receiver.
 *
 * ── On webhook authentication ─────────────────────────────────────────────────
 * YooKassa does NOT sign notifications with an HMAC by default. Their docs
 * describe exactly two ways to authenticate a notification: the source IP
 * address, and the current status of the object in the API. A shared-secret
 * signature only exists if "signature for webhooks" is separately enabled in the
 * shop settings, and it is not on by default — code that assumes such a header
 * exists will accept forged notifications forever.
 *
 * So this handler uses three independent checks; a forged notification has to
 * get past all of them, and only the last one is required for soundness:
 *
 *   1. Source IP is inside YooKassa's published ranges (cheap filter, stops the
 *      obvious probes before we spend an API call).
 *   2. The payment is re-fetched from GET /v3/payments/{id} using the secret key
 *      and must report `status === 'succeeded' && paid === true`. Every value
 *      used below comes from that response, never from the notification body.
 *   3. metadata.order_id must resolve to a real order whose user, currency and
 *      snapshotted amount all match.
 *
 * An optional HMAC check is layered on top when YOOKASSA_WEBHOOK_SECRET is set.
 * Fulfilment is idempotent, so a replayed notification cannot deliver twice.
 */

import {
  createSignedDownloadUrl,
  loadOrderById,
  loadProductById,
  markOrderDelivered,
  markOrderFailedByProviderPaymentId,
  markOrderPaid,
} from '../../_shared/db'
import { getClientIp, isIpAllowed } from '../../_shared/ip'
import { sendDocument } from '../../_shared/telegram'
import { getPayment, type YooKassaNotification } from '../../_shared/yookassa'

/**
 * YooKassa's published notification source ranges:
 * https://yookassa.ru/developers/using-api/webhooks
 * Override with YOOKASSA_WEBHOOK_ALLOWED_IPS if they change.
 */
const YOOKASSA_IPS =
  '185.71.76.0/27,185.71.77.0/27,77.75.153.0/25,77.75.156.11,77.75.156.35,77.75.154.128/25,2a02:5180::/32'

export const handler = async (request: Request): Promise<Response> => {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  // --- 1. Source IP allowlist ---------------------------------------------
  const clientIp = getClientIp(request)
  const allowlist = process.env.YOOKASSA_WEBHOOK_ALLOWED_IPS ?? YOOKASSA_IPS

  if (!isIpAllowed(clientIp, allowlist)) {
    console.warn('[yookassa-webhook] rejected source ip', { clientIp })
    return new Response('Forbidden', { status: 403 })
  }

  const rawBody = await request.text()

  // --- Optional HMAC, only when signatures are enabled in the shop ---------
  const secret = process.env.YOOKASSA_WEBHOOK_SECRET
  if (secret) {
    const provided =
      request.headers.get('X-Ya-Signature') ??
      request.headers.get('X-Notification-Signature')

    if (!provided || !(await verifySignature(rawBody, provided, secret))) {
      console.warn('[yookassa-webhook] signature mismatch')
      return new Response('Forbidden', { status: 403 })
    }
  }

  let notification: YooKassaNotification
  try {
    notification = JSON.parse(rawBody) as YooKassaNotification
  } catch {
    return new Response('Bad request', { status: 400 })
  }

  if (notification?.type !== 'notification' || !notification.object?.id) {
    return new Response('OK', { status: 200 })
  }

  try {
    await dispatch(notification)
  } catch (e) {
    // Return 500 so YooKassa keeps retrying for up to 24h — that is the recovery
    // path for a transient Supabase or Bot API outage. It stays idempotent.
    console.error('[yookassa-webhook] handler failed', {
      event: notification.event,
      paymentId: notification.object?.id,
      error: e instanceof Error ? e.message : String(e),
    })
    return new Response('Internal error', { status: 500 })
  }

  return new Response('OK', { status: 200 })
}

async function dispatch(notification: YooKassaNotification): Promise<void> {
  switch (notification.event) {
    case 'payment.succeeded':
      await fulfilFromPayment(notification.object.id)
      break

    case 'payment.canceled':
    case 'payment.failed':
      await markCancelled(notification.object.id, notification.object.status)
      break

    default:
      // payment.pending / waiting_for_capture: not terminal for an
      // instant-capture payment, so acknowledge and wait.
      break
  }
}

/**
 * The authoritative fulfilment path.
 *
 * Takes only the payment id from the notification; everything else is read back
 * from the YooKassa API and our own database.
 */
async function fulfilFromPayment(paymentId: string): Promise<void> {
  const payment = await getPayment(paymentId)

  if (payment.status !== 'succeeded' || payment.paid !== true) {
    console.warn('[yookassa-webhook] payment is not actually paid', {
      paymentId: payment.id,
      status: payment.status,
      paid: payment.paid,
    })
    return
  }

  const metadata = payment.metadata ?? {}
  const orderId = metadata.order_id
  const metadataUserId = metadata.user_id

  if (!orderId || !metadataUserId) {
    console.error('[yookassa-webhook] payment carries no metadata', { paymentId: payment.id })
    return
  }

  const order = await loadOrderById(orderId)
  if (!order) {
    console.error('[yookassa-webhook] no such order', { orderId, paymentId })
    return
  }

  if (order.gateway !== 'yookassa') {
    console.error('[yookassa-webhook] order belongs to another gateway', {
      orderId,
      gateway: order.gateway,
    })
    return
  }

  // The payment must be the one we created for this order. Guards against a
  // legitimately-paid payment being pointed at someone else's order via
  // metadata.
  if (order.provider_payment_id && order.provider_payment_id !== payment.id) {
    console.error('[yookassa-webhook] payment id does not match order', { orderId, paymentId })
    return
  }

  if (order.user_id !== Number(metadataUserId)) {
    console.error('[yookassa-webhook] metadata user mismatch', { orderId })
    return
  }

  if (payment.amount.currency !== order.currency) {
    console.error('[yookassa-webhook] currency mismatch', {
      orderId,
      expected: order.currency,
      got: payment.amount.currency,
    })
    return
  }

  // Compared against the amount snapshotted when the order was created, so a
  // later price edit cannot rewrite history.
  if (!sameAmount(payment.amount.value, order.amount)) {
    console.error('[yookassa-webhook] amount mismatch', {
      orderId,
      expected: order.amount,
      got: payment.amount.value,
    })
    return
  }

  // Atomic transition guarded on status='pending'. A duplicate notification
  // updates zero rows and stops here, which is the replay barrier.
  const paid = await markOrderPaid({ orderId, providerPaymentId: payment.id })
  if (!paid) {
    console.log('[yookassa-webhook] order already settled, not redelivering', { orderId })
    return
  }

  await deliverFile(paid.id, paid.user_id)
}

async function markCancelled(paymentId: string, status: string): Promise<void> {
  await markOrderFailedByProviderPaymentId(paymentId, `yookassa:${status}`)
}

/**
 * Sends the purchased file.
 *
 * The order is already `paid` at this point, so a delivery error must leave it
 * `paid` rather than `pending` — that is what lets the reconcile job retry it
 * without risking a second charge.
 */
async function deliverFile(orderId: string, userId: number): Promise<void> {
  const order = await loadOrderById(orderId)
  if (!order || order.status === 'delivered') return

  // Deliberately not loadPurchasableProduct: a product deactivated after the
  // purchase must still be delivered.
  const product = await loadProductById(order.product_id)
  if (!product) {
    console.error('[deliver] product row missing for paid order', {
      orderId,
      productId: order.product_id,
    })
    return
  }

  const signedUrl = await createSignedDownloadUrl(product.file_path)

  await sendDocument(
    userId,
    signedUrl,
    `Покупка: ${product.title}\nСпасибо за покупку! Файл во вложении.`,
  )

  await markOrderDelivered(orderId)
  console.log('[deliver] file sent', { orderId, userId })
}

/**
 * Exact decimal comparison.
 *
 * `Number('490.10') === Number('490.1')` is true, but a direct string compare
 * would say they differ, and float formatting can go either way. Comparing
 * integer minor units is unambiguous.
 */
export function sameAmount(a: string, b: string): boolean {
  const toMinor = (value: string): bigint | null => {
    const m = /^\s*(\d+)(?:[.,](\d{1,2}))?\s*$/.exec(value)
    if (!m) return null
    const frac = (m[2] ?? '').padEnd(2, '0')
    return BigInt(m[1]) * 100n + BigInt(frac)
  }

  const left = toMinor(a)
  const right = toMinor(b)
  if (left === null || right === null) return false
  return left === right
}

/** Generic HMAC-SHA256 verification for the optional signature header. */
async function verifySignature(
  rawBody: string,
  provided: string,
  secret: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )

  const signature = provided.startsWith('sha256=') ? provided.slice(7) : provided

  try {
    return await crypto.subtle.verify(
      'HMAC',
      key,
      hexToBytes(signature),
      new TextEncoder().encode(rawBody),
    )
  } catch {
    return false
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim()
  const out = new Uint8Array(Math.floor(clean.length / 2))
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16)
  }
  return out
}