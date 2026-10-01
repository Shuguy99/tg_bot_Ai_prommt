import { loadOrderById } from '../../_shared/db'
import { HttpError, json, requireUser, withErrorHandling } from '../../_shared/http'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * GET /api/orders/{id}
 *
 * Used by the client to poll until the webhook settles the order.
 *
 * The order row is only returned when it belongs to the caller. Without that
 * check, anyone could enumerate order ids and watch other people's purchases.
 */
export const handler = withErrorHandling(async (request) => {
  if (request.method !== 'GET') {
    throw new HttpError('Метод не поддерживается', 405)
  }

  const user = await requireUser(request)

  const orderId = new URL(request.url).pathname.split('/').pop() ?? ''
  if (!UUID_RE.test(orderId)) {
    throw new HttpError('Некорректный идентификатор заказа', 400)
  }

  const order = await loadOrderById(orderId)

  // Same response for "does not exist" and "not yours": a 404 vs 403 split would
  // confirm which order ids are real.
  if (!order || order.user_id !== user.id) {
    throw new HttpError('Заказ не найден', 404)
  }

  return json({
    id: order.id,
    user_id: order.user_id,
    product_id: order.product_id,
    amount: Number(order.amount),
    currency: order.currency,
    gateway: order.gateway,
    status: order.status,
    provider_payment_id: order.provider_payment_id,
    delivered_at: order.delivered_at,
    created_at: order.created_at,
  })
})