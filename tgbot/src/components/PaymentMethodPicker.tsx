import { useEffect, useRef, useState } from 'react'
import {
  ApiRequestError,
  createStarsInvoice,
  createYooKassaPayment,
  getOrder,
} from '@/lib/api'
import { formatRub, formatStars, newIdempotencyKey } from '@/lib/format'
import { haptic, notify, openLink } from '@/lib/telegram'
import type { Product } from '@/lib/types'

type Gateway = 'yookassa' | 'telegram_stars'

interface Props {
  product: Product
  onClose: () => void
}

export default function PaymentMethodPicker({ product, onClose }: Props) {
  const [busy, setBusy] = useState<Gateway | null>(null)
  const [error, setError] = useState<string | null>(null)

  // One key per picker session: every gateway attempt for this product shares it
  // so a retry cannot create a second order (and a second charge).
  const idempotencyKey = useRef(newIdempotencyKey()).current

  // Polling outlives the sheet: closing it must stop the loop, otherwise the
  // component keeps a timer alive for 10 minutes and fires haptics after unmount.
  const cancelled = useRef(false)
  useEffect(() => {
    cancelled.current = false
    return () => {
      cancelled.current = true
    }
  }, [])

  const starsAvailable = typeof product.stars_price === 'number' && product.stars_price > 0

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  async function pay(gateway: Gateway) {
    setBusy(gateway)
    setError(null)

    try {
      const intent =
        gateway === 'yookassa'
          ? await createYooKassaPayment({
              productId: product.id,
              idempotencyKey,
            })
          : await createStarsInvoice({ productId: product.id, idempotencyKey })

      haptic('medium')
      // YooKassa: opens the confirmation page in Telegram's in-app browser.
      // Stars: opens the native invoice sheet.
      openLink(intent.confirmation_url)

      // The Mini App stays mounted, so keep polling until the webhook confirms
      // the order. Polling only reads status — it never grants access itself.
      void pollUntilTerminal(intent.order_id)
    } catch (e) {
      const message =
        e instanceof ApiRequestError ? e.message : 'Не удалось создать платёж. Попробуйте ещё раз.'
      setError(message)
      notify('error')
    } finally {
      setBusy(null)
    }
  }

  const pollUntilTerminal = async (orderId: string) => {
    const deadline = Date.now() + 10 * 60 * 1000

    while (Date.now() < deadline && !cancelled.current) {
      await sleep(3000)
      if (cancelled.current) return
      try {
        const order = await getOrder(orderId)
        if (order.status === 'delivered' || order.status === 'paid') {
          notify('success')
          haptic('heavy')
          return
        }
        if (order.status === 'failed' || order.status === 'refunded') {
          notify('error')
          return
        }
      } catch {
        // Transient network error while the payment tab is open: keep polling.
      }
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-black/60"
      role="dialog"
      aria-modal="true"
      aria-label="Способ оплаты"
      onClick={() => {
        if (!busy) onClose()
      }}
    >
      <div
        className="w-full max-w-md rounded-t-3xl bg-tg-bg p-5 pb-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-white/20" />

        <h2 className="text-lg font-bold">{product.title}</h2>
        <p className="mt-1 text-sm text-tg-hint">Выберите способ оплаты</p>

        <div className="mt-5 flex flex-col gap-3">
          <GatewayOption
            title="Оплатить картой (РФ)"
            subtitle={formatRub(product.price)}
            badge="ЮKassa"
            disabled={busy !== null}
            onClick={() => pay('yookassa')}
          />

          <GatewayOption
            title="Telegram Stars"
            subtitle={starsAvailable ? formatStars(product.stars_price!) : 'Недоступно для этого товара'}
            badge="Telegram"
            disabled={busy !== null || !starsAvailable}
            onClick={() => pay('telegram_stars')}
          />
        </div>

        {error && (
          <p role="alert" className="mt-4 rounded-xl bg-red-500/15 px-3 py-2 text-sm text-red-400">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={onClose}
          disabled={busy !== null}
          className="mt-5 w-full rounded-xl py-2.5 text-sm text-tg-hint transition active:scale-95 disabled:opacity-50"
        >
          Отмена
        </button>
      </div>
    </div>
  )
}

function GatewayOption({
  title,
  subtitle,
  badge,
  disabled,
  onClick,
}: {
  title: string
  subtitle: string
  badge: string
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-left transition active:scale-[0.99] disabled:opacity-50"
    >
      <span>
        <span className="block font-medium">{title}</span>
        <span className="mt-0.5 block text-sm text-tg-hint">{subtitle}</span>
      </span>
      <span className="rounded-lg bg-white/10 px-2 py-1 text-[11px] text-tg-hint">{badge}</span>
    </button>
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}