const rubFormatter = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function formatRub(value: number): string {
  return rubFormatter.format(value)
}

/** Stars are always whole numbers; Intl renders them without decimals. */
export function formatStars(value: number): string {
  return `${new Intl.NumberFormat('ru-RU').format(value)} ★`
}

/** UUID v4 from crypto.getRandomValues; used for client-side idempotency keys. */
export function newIdempotencyKey(): string {
  // Bound to a local first: narrowing the global `crypto` directly with
  // `'randomUUID' in crypto` reduces the else branch to `never`, because Crypto
  // has no other members to fall back to.
  const webCrypto = globalThis.crypto

  if (typeof webCrypto.randomUUID === 'function') {
    return webCrypto.randomUUID()
  }

  const bytes = new Uint8Array(16)
  webCrypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}