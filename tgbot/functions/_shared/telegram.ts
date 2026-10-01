/**
 * Telegram Bot API wrapper.
 *
 * Only the parts needed to sell files: initData signature verification (the
 * trust boundary for user identity) and file delivery.
 */

const API_BASE = 'https://api.telegram.org'

interface TelegramResponse<T> {
  ok: boolean
  result?: T
  description?: string
  error_code?: number
}

export class TelegramApiError extends Error {
  readonly errorCode: number | undefined

  constructor(description: string, errorCode?: number) {
    super(description)
    this.name = 'TelegramApiError'
    this.errorCode = errorCode
  }
}

async function callBotApi<T>(method: string, payload: Record<string, unknown>): Promise<T> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) throw new Error('Missing TELEGRAM_BOT_TOKEN')

  const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  const data = (await res.json().catch(() => ({}))) as TelegramResponse<T>

  if (!data.ok) {
    throw new TelegramApiError(data.description ?? `Telegram API error on ${method}`, data.error_code)
  }

  return data.result as T
}

// -----------------------------------------------------------------------------
// initData verification
// -----------------------------------------------------------------------------

export interface TelegramUser {
  id: number
  first_name?: string
  last_name?: string
  username?: string
  language_code?: string
}

export interface VerifiedInitData {
  user: TelegramUser
  authDate: number
}

async function hmacSha256(key: Uint8Array, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message))
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Verifies Telegram WebApp initData per
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * Steps: build data_check_string (all fields except `hash`, sorted by key),
 * derive secret_key = HMAC_SHA256("WebAppData", bot_token), then compare
 * HMAC_SHA256(secret_key, data_check_string) with the received hash.
 *
 * This MUST run server-side. The client's own user object is forgeable, so any
 * endpoint that acts on behalf of a user has to call this first.
 */
export async function verifyInitData(
  initData: string,
  maxAgeSeconds = 300,
): Promise<VerifiedInitData> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) throw new Error('Missing TELEGRAM_BOT_TOKEN')
  if (!initData) throw new Error('initData is empty')

  const params = new URLSearchParams(initData)
  const hash = params.get('hash')
  if (!hash) throw new Error('initData has no hash')

  params.delete('hash')
  params.delete('signature')

  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')

  // secret_key = HMAC-SHA256(key: "WebAppData", msg: bot_token) -> 32 raw bytes.
  // Per Telegram's spec the *raw* digest is the key for the next HMAC; hex-encoding
  // it here (a common mistake) makes every legitimate signature mismatch.
  const secretKey = await hmacSha256(new TextEncoder().encode('WebAppData'), token)
  const expected = toHex(await hmacSha256(new Uint8Array(secretKey), dataCheckString))

  if (!timingSafeEqual(expected, hash)) {
    throw new Error('initData signature mismatch')
  }

  const authDateRaw = params.get('auth_date')
  const authDate = authDateRaw ? Number(authDateRaw) : 0
  if (!Number.isFinite(authDate) || authDate <= 0) {
    throw new Error('initData has no auth_date')
  }

  if (Date.now() / 1000 - authDate > maxAgeSeconds) {
    throw new Error('initData is stale')
  }

  const userRaw = params.get('user')
  if (!userRaw) throw new Error('initData has no user')

  return { user: JSON.parse(userRaw) as TelegramUser, authDate }
}

/** Constant-time string compare; avoids leaking the expected hash via timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

// -----------------------------------------------------------------------------
// invoicing (Telegram Stars)
// -----------------------------------------------------------------------------

export interface StarsInvoice {
  title: string
  description: string
  /** Echoed back in successful_payment.invoice_payload; keep <= 32 bytes. */
  payload: string
  /** Whole stars, e.g. 49 for 49 XTR. */
  amount: number
}

/**
 * createInvoiceLink produces a link that opens the native payment sheet and can
 * be opened from inside a Mini App. Currency is pinned to XTR (Stars) — Stars
 * are not convertible to RUB by this code path.
 */
export function createStarsInvoiceLink(invoice: StarsInvoice): Promise<string> {
  return callBotApi<string>('createInvoiceLink', {
    title: invoice.title.slice(0, 32),
    description: invoice.description.slice(0, 255),
    payload: invoice.payload,
    currency: 'XTR',
    prices: [
      {
        label: invoice.title.slice(0, 32),
        // For XTR the amount field is the number of stars, as an integer.
        amount: Math.trunc(invoice.amount),
      },
    ],
    max_tip_amount: 0,
  })
}

// -----------------------------------------------------------------------------
// delivery
// -----------------------------------------------------------------------------

/**
 * Sends the purchased file to the buyer.
 *
 * `fileUrl` must be a short-lived signed URL from the private bucket, not a
 * permanent public link. Telegram fetches it server-side, so the URL only needs
 * to survive a few seconds, but an hour of headroom covers retries.
 */
export async function sendDocument(
  chatId: number,
  fileUrl: string,
  caption: string,
): Promise<void> {
  await callBotApi('sendDocument', {
    chat_id: chatId,
    document: fileUrl,
    // parse_mode is deliberately omitted: product titles are user-controlled
    // and would break the message (or inject markup) if interpreted.
    caption: caption.slice(0, 1024),
    disable_notification: false,
    protect_content: true,
  })
}

export function sendMessage(chatId: number, text: string): Promise<void> {
  return callBotApi<void>('sendMessage', {
    chat_id: chatId,
    text: text.slice(0, 4096),
  }).then(() => undefined)
}

/**
 * Answers pre_checkout_query within Telegram's 10s window. Failure to answer
 * blocks the user from paying, so this must be called on every such update.
 *
 * `preCheckoutQueryId` is the `id` of the pre_checkout_query update, NOT the
 * invoice payload.
 */
export function answerPreCheckout(
  preCheckoutQueryId: string,
  ok: boolean,
  errorMessage?: string,
): Promise<void> {
  return callBotApi<void>('answerPreCheckoutQuery', {
    pre_checkout_query_id: preCheckoutQueryId,
    ok,
    ...(errorMessage ? { error_message: errorMessage.slice(0, 200) } : {}),
  }).then(() => undefined)
}