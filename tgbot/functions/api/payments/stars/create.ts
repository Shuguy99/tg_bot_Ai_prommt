import { createOrder, loadPurchasableProduct, upsertTelegramUser } from '../../_shared/db'
import { HttpError, json, requireUser, withErrorHandling } from '../../_shared/http'
import { createStarsInvoiceLink } from '../../_shared/telegram'

interface CreateInvoiceBody {
  product_id?: string
  idempotency_key?: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const handler = withErrorHandling(async (request) => {
  if (request.method !== 'POST') {
    throw new HttpError('Метод не поддерживается', 405)
  }

  const user = await requireUser(request)

  const body = (await request.json().catch(() => ({}))) as CreateInvoiceBody

  if (!body.product_id || !UUID_RE.test(body.product_id)) {
    throw new HttpError('Некорректный product_id', 400)
  }
  if (!body.idempotency_key || body.idempotency_key.length < 8 || body.idempotency_key.length > 128) {
    throw new HttpError('Некорректный idempotency_key', 400)
  }

  const product = await loadPurchasableProduct(body.product_id)
  if (!product) throw new HttpError('Товар не найден или недоступен', 404)

  // Stars are whole units and must be priced explicitly; they are never
  // converted from the RUB price at request time.
  if (product.stars_price === null || product.stars_price <= 0) {
    throw new HttpError('Товар не продаётся за Telegram Stars', 409)
  }

  const order = await createOrder({
    userId: user.id,
    productId: product.id,
    // For XTR the "amount" column holds the star count as an integer.
    amount: String(product.stars_price),
    currency: 'XTR',
    gateway: 'telegram_stars',
    idempotencyKey: body.idempotency_key,
  })

  // payload is echoed back in successful_payment.invoice_payload and is how the
  // Telegram webhook resolves this order. 32-byte cap in Bot API.
  const payload = order.id

  const invoiceUrl = await createStarsInvoiceLink({
    title: product.title.slice(0, 32),
    description: product.description?.slice(0, 255) ?? product.title.slice(0, 255),
    payload,
    amount: product.stars_price,
  })

  await upsertTelegramUser(user)

  return json({ order_id: order.id, confirmation_url: invoiceUrl })
})