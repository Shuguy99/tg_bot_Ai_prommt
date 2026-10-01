/**
 * YooKassa REST client (api.yookassa.ru/v3), Basic Auth scheme.
 *
 * Runs only in serverless functions — the secret key must never reach the
 * browser. All functions are thin and stateless; no SDK dependency.
 */

const API_BASE = 'https://api.yookassa.ru/v3'

export type YooKassaAmount = {
  value: string
  currency: string
}

export interface YooKassaPayment {
  id: string
  status: string
  paid: boolean
  amount: YooKassaAmount
  confirmation?: {
    type: string
    confirmation_url?: string
  }
  metadata?: Record<string, string>
  created_at: string
  refundable?: boolean
  test?: boolean
}

export interface YooKassaNotification {
  type: 'notification'
  event: string
  object: YooKassaPayment
}

export class YooKassaError extends Error {
  readonly status: number
  readonly body: string

  constructor(status: number, body: string) {
    super(`YooKassa API error ${status}: ${body.slice(0, 500)}`)
    this.name = 'YooKassaError'
    this.status = status
    this.body = body
  }
}

interface RequestOptions {
  method: 'POST' | 'GET'
  path: string
  body?: unknown
  idempotenceKey?: string
}

async function yookassaRequest<T>(opts: RequestOptions): Promise<T> {
  const shopId = env('YOOKASSA_SHOP_ID')
  const secretKey = env('YOOKASSA_SECRET_KEY')

  const headers: Record<string, string> = {
    // YooKassa requires HTTP Basic auth: shop id as user, secret key as password.
    Authorization: `Basic ${btoa(`${shopId}:${secretKey}`)}`,
    'Content-Type': 'application/json',
  }

  if (opts.idempotenceKey) {
    // Required by YooKassa for POST /payments so a network retry cannot create
    // two payments for one order.
    headers['Idempotence-Key'] = opts.idempotenceKey
  }

  const res = await fetch(`${API_BASE}${opts.path}`, {
    method: opts.method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })

  const text = await res.text()

  if (!res.ok) {
    throw new YooKassaError(res.status, text)
  }

  return (text ? JSON.parse(text) : {}) as T
}

export interface CreatePaymentArgs {
  amountRub: string
  description: string
  returnUrl: string
  /** Echoed back on the notification; must stay short (YooKassa value limit 500). */
  metadata: Record<string, string>
  idempotenceKey: string
  receipt?: YooKassaReceipt
  /** Test payments use the sandbox and never move real money. */
  test?: boolean
}

export type YooKassaReceipt = {
  customer: {
    full_name: string
    email?: string
    phone?: string
  }
  items: Array<{
    description: string
    quantity: string
    amount: YooKassaAmount
    vat_code: 1 | 2 | 3 | 5 | 6 | 7
    payment_subject: 'commodity' | 'service' | 'non_operating_gains'
    payment_mode: 'full_payment' | 'partial_payment'
  }>
}

/**
 * POST /v3/payments
 *
 * `amount.value` is always sent as a decimal string ("199.00"), never a float,
 * so no rounding error can change the charged amount.
 */
export function createPayment(args: CreatePaymentArgs): Promise<YooKassaPayment> {
  const body: Record<string, unknown> = {
    amount: { value: args.amountRub, currency: 'RUB' },
    capture: true,
    confirmation: {
      type: 'redirect',
      return_url: args.returnUrl,
    },
    description: args.description.slice(0, 128),
    metadata: args.metadata,
  }

  if (args.receipt) body.receipt = args.receipt
  if (args.test !== undefined) body.test = args.test

  return yookassaRequest<YooKassaPayment>({
    method: 'POST',
    path: '/payments',
    body,
    idempotenceKey: args.idempotenceKey,
  })
}

/**
 * GET /v3/payments/{id}
 *
 * Used by the webhook handler as the authoritative source of truth: the
 * notification body itself is treated as attacker-controlled input.
 */
export function getPayment(paymentId: string): Promise<YooKassaPayment> {
  return yookassaRequest<YooKassaPayment>({
    method: 'GET',
    path: `/payments/${encodeURIComponent(paymentId)}`,
  })
}

function env(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`)
  }
  return value
}