/**
 * Telegram Bot API webhook (setWebhook target).
 *
 * Handles the Stars gateway:
 *   - pre_checkout_query  -> must be answered within 10s or the user cannot pay
 *   - message.successful_payment -> the actual Stars charge, then file delivery
 *
 * Payment is confirmed by Telegram itself, so there is no equivalent of the
 * YooKassa "re-fetch the object" step. What does need care is idempotency:
 * Telegram retries updates, and a duplicate successful_payment must not deliver
 * the file twice.
 */

import {
  createSignedDownloadUrl,
  loadOrderById,
  loadProductById,
  markOrderDelivered,
  markOrderPaid,
} from '../../_shared/db'
import { answerPreCheckout, sendDocument } from '../../_shared/telegram'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface TelegramUpdate {
  update_id: number
  pre_checkout_query?: {
    id: string
    from: { id: number }
    currency: string
    total_amount: number
    invoice_payload: string
  }
  message?: {
    message_id: number
    from: { id: number }
    chat: { id: number }
    successful_payment?: {
      currency: string
      total_amount: number
      invoice_payload: string
      telegram_payment_charge_id: string
      provider_payment_charge_id?: string
    }
  }
}

export const handler = async (request: Request): Promise<Response> => {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  // Optional shared secret so only Telegram can probe the endpoint. Telegram
  // sends this as the X-Telegram-Bot-Api-Secret-Token header when it is set via
  // setWebhook.
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET
  if (expectedSecret) {
    const provided = request.headers.get('X-Telegram-Bot-Api-Secret-Token')
    if (provided !== expectedSecret) {
      return new Response('Forbidden', { status: 403 })
    }
  }

  let update: TelegramUpdate
  try {
    update = (await request.json()) as TelegramUpdate
  } catch {
    return new Response('Bad request', { status: 400 })
  }

  if (update.pre_checkout_query) {
    await handlePreCheckout(update.pre_checkout_query)
    return new Response('OK', { status: 200 })
  }

  const payment = update.message?.successful_payment
  if (payment) {
    try {
      await handleSuccessfulPayment(payment, update.message!.from.id)
    } catch (e) {
      // 500 makes Telegram redeliver the update; the paid-guard below keeps that
      // safe to retry.
      console.error('[telegram-webhook] successful_payment failed', {
        payload: payment.invoice_payload,
        error: e instanceof Error ? e.message : String(e),
      })
      return new Response('Internal error', { status: 500 })
    }
  }

  return new Response('OK', { status: 200 })
}

/**
 * Validate before Telegram takes the money. Answering `ok: false` here aborts
 * the purchase cleanly, which is much better than being charged and then failing
 * to deliver.
 */
async function handlePreCheckout(query: NonNullable<TelegramUpdate['pre_checkout_query']>): Promise<void> {
  let ok = false
  let message = 'Заказ не найден'

  if (query.currency === 'XTR' && UUID_RE.test(query.invoice_payload)) {
    const order = await loadOrderById(query.invoice_payload)

    if (order) {
      if (order.gateway !== 'telegram_stars') {
        message = 'Неверный способ оплаты для этого заказа'
      } else if (order.status !== 'pending') {
        // Already paid or failed: refuse rather than charge twice.
        message = 'Этот заказ уже обработан'
      } else if (order.user_id !== query.from.id) {
        message = 'Заказ принадлежит другому пользователю'
      } else if (Number(order.amount) !== query.total_amount) {
        message = 'Сумма платежа не совпадает с заказом'
      } else {
        ok = true
      }
    }
  }

  // Must always be called, even on rejection: Telegram blocks the payment
  // otherwise. Failures are logged but never surface as a 500 to the retry loop.
  try {
    await answerPreCheckout(query.id, ok, ok ? undefined : message)
  } catch (e) {
    console.error('[telegram-webhook] answerPreCheckoutQuery failed', {
      queryId: query.id,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}

async function handleSuccessfulPayment(
  payment: NonNullable<NonNullable<TelegramUpdate['message']>['successful_payment']>,
  buyerId: number,
): Promise<void> {
  const order = await loadOrderById(payment.invoice_payload)

  if (!order) {
    console.error('[telegram-webhook] paid invoice with unknown payload', {
      payload: payment.invoice_payload,
    })
    return
  }

  if (order.gateway !== 'telegram_stars') {
    console.error('[telegram-webhook] wrong gateway for order', { orderId: order.id })
    return
  }

  if (order.user_id !== buyerId) {
    console.error('[telegram-webhook] payer does not own the order', { orderId: order.id })
    return
  }

  if (payment.currency !== 'XTR') {
    console.error('[telegram-webhook] unexpected currency', { orderId: order.id, payment.currency })
    return
  }

  if (Number(order.amount) !== payment.total_amount) {
    console.error('[telegram-webhook] stars amount mismatch', {
      orderId: order.id,
      expected: Number(order.amount),
      got: payment.total_amount,
    })
    return
  }

  // Atomic transition guarded on status='pending': the retry of this same
  // update updates zero rows and returns here, so the file ships exactly once.
  const paid = await markOrderPaid({
    orderId: order.id,
    providerPaymentId: payment.telegram_payment_charge_id,
  })

  if (!paid) {
    console.log('[telegram-webhook] order already settled, not redelivering', { orderId: order.id })
    return
  }

  // Uses loadProductById (ignores is_active) so a product deactivated after the
  // purchase is still delivered.
  const product = await loadProductById(order.product_id)
  if (!product) {
    console.error('[telegram-webhook] product row missing for paid order', {
      orderId: order.id,
      productId: order.product_id,
    })
    return
  }

  const signedUrl = await createSignedDownloadUrl(product.file_path)

  await sendDocument(
    buyerId,
    signedUrl,
    `Покупка: ${product.title}\nСпасибо за покупку! Файл во вложении.`,
  )

  await markOrderDelivered(order.id)
  console.log('[telegram-webhook] file sent', { orderId: order.id, buyerId })
}