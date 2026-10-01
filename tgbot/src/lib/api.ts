import { z } from 'zod'
import { getInitData } from './telegram'
import type { Order } from './types'

/**
 * Backend base URL. Defaults to the deployment origin, which is correct for the
 * Cloudflare Pages layout where static assets and /api/* Functions share a host.
 */
export const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? ''

export class ApiRequestError extends Error {
  readonly status: number
  readonly code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
    this.code = code
  }
}

const orderSchema = z.object({
  id: z.string().uuid(),
  user_id: z.number(),
  product_id: z.string().uuid(),
  amount: z.number(),
  currency: z.enum(['RUB', 'XTR']),
  gateway: z.enum(['yookassa', 'telegram_stars']),
  status: z.enum(['pending', 'paid', 'delivered', 'failed', 'refunded']),
  provider_payment_id: z.string().nullable(),
  delivered_at: z.string().nullable(),
  created_at: z.string(),
})

export type PaymentIntent = {
  order_id: string
  /** YooKassa confirmation URL, or a Telegram Stars invoice link. */
  confirmation_url: string
}

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const { method = 'GET', body, signal } = init

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // The backend verifies this HMAC and derives user_id from it. It is the only
    // identity signal; sending a client-chosen user id would be trivially forged.
    'X-Telegram-Init-Data': getInitData(),
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
    credentials: 'omit',
  })

  const raw = await res.text()
  let parsed: unknown
  try {
    parsed = raw ? JSON.parse(raw) : {}
  } catch {
    throw new ApiRequestError(res.status, 'Сервер вернул не-JSON ответ', 'bad_response')
  }

  if (!res.ok) {
    const err = parsed as { error?: string; code?: string }
    throw new ApiRequestError(res.status, err.error ?? `HTTP ${res.status}`, err.code)
  }

  const result = schema.safeParse(parsed)
  if (!result.success) {
    throw new ApiRequestError(res.status, 'Неожиданный формат ответа сервера', 'schema_mismatch')
  }
  return result.data
}

const paymentIntentSchema = z.object({
  order_id: z.string().uuid(),
  confirmation_url: z.string().url(),
})

export function createYooKassaPayment(input: {
  productId: string
  idempotencyKey: string
  signal?: AbortSignal
}): Promise<PaymentIntent> {
  return request(
    '/api/payments/yookassa/create',
    paymentIntentSchema,
    {
      method: 'POST',
      signal: input.signal,
      // Only the product id crosses the wire. The amount is read from the DB
      // server-side so a tampered client cannot choose what it pays.
      body: { product_id: input.productId, idempotency_key: input.idempotencyKey },
    },
  )
}

export function createStarsInvoice(input: {
  productId: string
  idempotencyKey: string
  signal?: AbortSignal
}): Promise<PaymentIntent> {
  return request('/api/payments/stars/create', paymentIntentSchema, {
    method: 'POST',
    signal: input.signal,
    body: { product_id: input.productId, idempotency_key: input.idempotencyKey },
  })
}

export function getOrder(orderId: string, signal?: AbortSignal): Promise<Order> {
  return request(`/api/orders/${encodeURIComponent(orderId)}`, orderSchema, { signal })
}