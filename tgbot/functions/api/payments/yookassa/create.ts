import {
  createOrder,
  getAdminClient,
  loadPurchasableProduct,
  upsertTelegramUser,
} from '../../../_shared/db'
import { HttpError, json, requireBaseUrl, requireUser, withErrorHandling } from '../../../_shared/http'
import { createPayment, type YooKassaReceipt } from '../../../_shared/yookassa'

interface CreatePaymentBody {
  product_id?: string
  idempotency_key?: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const handler = withErrorHandling(async (request) => {
  if (request.method !== 'POST') {
    throw new HttpError('Метод не поддерживается', 405)
  }

  // Identity comes from verified initData, never from the request body.
  const user = await requireUser(request)

  const body = (await request.json().catch(() => ({}))) as CreatePaymentBody

  if (!body.product_id || !UUID_RE.test(body.product_id)) {
    throw new HttpError('Некорректный product_id', 400)
  }
  if (!body.idempotency_key || body.idempotency_key.length < 8 || body.idempotency_key.length > 128) {
    throw new HttpError('Некорректный idempotency_key', 400)
  }

  // The amount is read from the DB, not from the request. A tampered client
  // cannot decide what it pays.
  const product = await loadPurchasableProduct(body.product_id)
  if (!product) throw new HttpError('Товар не найден или недоступен', 404)

  const amount = product.price // numeric -> exact decimal string, e.g. "490.00"

  const order = await createOrder({
    userId: user.id,
    productId: product.id,
    amount,
    currency: 'RUB',
    gateway: 'yookassa',
    idempotencyKey: body.idempotency_key,
  })

  const baseUrl = requireBaseUrl()

  const payment = await createPayment({
    amountRub: amount,
    description: product.title,
    returnUrl: `${baseUrl}/?order=${order.id}`,
    idempotenceKey: body.idempotency_key,
    metadata: {
      order_id: order.id,
      user_id: String(user.id),
      product_id: product.id,
    },
    ...(process.env.YOOKASSA_REQUIRE_RECEIPT === 'true'
      ? { receipt: buildReceipt(user, product.title, amount) }
      : {}),
    ...(process.env.YOOKASSA_TEST_MODE === 'true' ? { test: true } : {}),
  })

  // Record the payment id on the order so the webhook can resolve the row
  // even if metadata is stripped somewhere in transit.
  await bindProviderPaymentId(order.id, payment.id)

  await upsertTelegramUser(user)

  const confirmationUrl = payment.confirmation?.confirmation_url
  if (!confirmationUrl) {
    throw new HttpError('YooKassa не вернул ссылку на оплату', 502)
  }

  return json({ order_id: order.id, confirmation_url: confirmationUrl })
})

async function bindProviderPaymentId(orderId: string, paymentId: string): Promise<void> {
  await getAdminClient()
    .from('orders')
    .update({ provider_payment_id: paymentId })
    .eq('id', orderId)
}

/**
 * 54-FZ receipts. Required if the seller is an ИП/ООО and the buyer asks for a
 * cheque. Enabled via YOOKASSA_REQUIRE_RECEIPT=true once the shop has decided
 * its tax regime — filling this in wrong is a bookkeeping problem, not a
 * technical one.
 */
function buildReceipt(
  user: { first_name?: string; last_name?: string },
  productTitle: string,
  amount: string,
): YooKassaReceipt {
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Покупатель'

  return {
    customer: {
      full_name: fullName,
      // Phone/email must come from a point where the buyer gave consent for a
      // cheque; initData carries neither, so add it explicitly when collecting.
    },
    items: [
      {
        description: productTitle.slice(0, 100),
        quantity: '1',
        amount: { value: amount, currency: 'RUB' },
        vat_code: 1, // НДС 20%
        payment_subject: 'service',
        payment_mode: 'full_payment',
      },
    ],
  }
}