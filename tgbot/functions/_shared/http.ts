/**
 * Small helpers shared by every function: CORS, JSON responses, auth gate.
 */

import { verifyInitData, type TelegramUser } from './telegram'

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

/**
 * The Mini App is served from the same origin as the API on Cloudflare Pages, so
 * CORS is only needed for local dev tunnels. Echoing an arbitrary Origin would
 * defeat the purpose, so the allowlist is explicit.
 */
export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') ?? ''
  const allowed = parseAllowedOrigins()

  const headers: Record<string, string> = {
    Vary: 'Origin',
  }

  if (allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
    headers['Access-Control-Allow-Headers'] =
      'Content-Type, X-Telegram-Init-Data, Idempotency-Key'
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    headers['Access-Control-Max-Age'] = '86400'
  }

  return headers
}

export function parseAllowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS ?? ''
  const fromEnv = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  if (fromEnv.length > 0) return fromEnv

  // Sensible dev defaults when nothing is configured.
  return [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ]
}

export function preflight(request: Request): Response | null {
  if (request.method !== 'OPTIONS') return null
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

/**
 * Reads and verifies `X-Telegram-Init-Data`.
 *
 * Everything that acts on behalf of a user goes through here. The client is
 * untrusted: `initDataUnsafe` can be edited freely, so only the HMAC-checked
 * copy counts.
 */
export async function requireUser(request: Request): Promise<TelegramUser> {
  const initData = request.headers.get('X-Telegram-Init-Data') ?? ''

  if (!initData) {
    throw new AuthError('Отсутствует Telegram initData', 401)
  }

  try {
    const verified = await verifyInitData(initData)
    return verified.user
  } catch (e) {
    const message = e instanceof Error ? e.message : 'initData validation failed'
    throw new AuthError(`Не удалось проверить initData: ${message}`, 401)
  }
}

export class AuthError extends Error {
  readonly status: number

  constructor(message: string, status = 401) {
    super(message)
    this.name = 'AuthError'
    this.status = status
  }
}

export class HttpError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

/** Wraps a handler so thrown AuthError/HttpError become JSON responses. */
export function withErrorHandling(
  handler: (request: Request, ctx: unknown) => Promise<Response>,
) {
  return async (request: Request, ctx: unknown): Promise<Response> => {
    const cors = corsHeaders(request)

    const pre = preflight(request)
    if (pre) return pre

    try {
      const res = await handler(request, ctx)
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v)
      return res
    } catch (e) {
      const status = e instanceof AuthError || e instanceof HttpError ? e.status : 500
      const message =
        status === 500
          ? 'Внутренняя ошибка сервера'
          : e instanceof Error
            ? e.message
            : 'Неизвестная ошибка'

      // Never echo internal details to the client on a 500.
      if (status === 500) {
        console.error('[handler]', e)
      }

      return new Response(JSON.stringify({ error: message }), {
        status,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          ...cors,
        },
      })
    }
  }
}

export function requireBaseUrl(): string {
  const base = process.env.APP_BASE_URL
  if (!base) throw new Error('Missing APP_BASE_URL')
  return base.replace(/\/$/, '')
}