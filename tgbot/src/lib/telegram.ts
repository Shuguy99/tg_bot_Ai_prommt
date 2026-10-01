/**
 * Thin wrapper around window.Telegram.WebApp.
 * Nothing here is a security boundary: initData is only trustworthy after the
 * server verifies its HMAC signature.
 */

function webApp() {
  return window.Telegram?.WebApp ?? null
}

/**
 * Raw initData string Telegram injects into the WebView. Sent to the backend on
 * every authenticated request; the backend re-derives user_id from it.
 */
export function getInitData(): string {
  return webApp()?.initData ?? ''
}

export function ready(): void {
  const wa = webApp()
  if (!wa) return
  wa.ready()
  wa.expand()
}

/**
 * Maps Telegram's themeParams onto CSS custom properties consumed by
 * tailwind.config.ts. Kept minimal on purpose.
 */
export function applyTheme(): void {
  const wa = webApp()
  if (!wa) return

  const p = wa.themeParams ?? {}
  const root = document.documentElement
  const set = (k: string, v: string | undefined, fallback: string) => {
    if (v) root.style.setProperty(k, v)
    else root.style.setProperty(k, fallback)
  }

  set('--tg-bg', p.bg_color, '#17212b')
  set('--tg-text', p.text_color, '#f5f5f5')
  set('--tg-hint', p.hint_color, '#7f8c98')
  set('--tg-link', p.link_color, '#62aeef')
  set('--tg-button', p.button_color, '#3ba3ec')
  set('--tg-button-text', p.button_text_color, '#ffffff')
}

type Haptic = 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'
type Notice = 'error' | 'success' | 'warning'

export function haptic(style: Haptic = 'light'): void {
  webApp()?.HapticFeedback?.impactOccurred(style)
}

export function notify(type: Notice): void {
  webApp()?.HapticFeedback?.notificationOccurred(type)
}

export function hapticSelection(): void {
  webApp()?.HapticFeedback?.selectionChanged()
}

/**
 * Opens an absolute URL in the in-app browser. Preferred over window.open for
 * YooKassa confirmation: it keeps the Mini App mounted underneath so the user
 * returns to it when the payment tab is dismissed.
 */
export function openLink(url: string): void {
  const wa = webApp()
  if (wa?.openTelegramLink) {
    wa.openTelegramLink(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

/** Must be called inside a click handler (user gesture). */
export function close(): void {
  webApp()?.close?.()
}