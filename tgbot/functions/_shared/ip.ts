/**
 * IP allowlist matching for webhook endpoints.
 *
 * Needed because YooKassa does not sign its notifications: the published way to
 * authenticate them is to check the source address against a fixed set of
 * ranges. Implemented here (rather than pulled in) because the logic is small
 * and it avoids a dependency in a hot auth path.
 *
 * This is defence in depth, not the primary control. The primary control is
 * re-fetching the payment from YooKassa with the secret key and checking its
 * real status — a spoofed IP alone cannot fake a paid order.
 */

interface Cidr {
  bytes: Uint8Array
  prefixBits: number
}

function parseIp(ip: string): Uint8Array | null {
  if (ip.includes(':')) return parseIpv6(ip)
  return parseIpv4(ip)
}

function parseIpv4(ip: string): Uint8Array | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null

  const out = new Uint8Array(4)
  for (let i = 0; i < 4; i++) {
    const n = Number(parts[i])
    if (!Number.isInteger(n) || n < 0 || n > 255) return null
    out[i] = n
  }
  return out
}

function parseIpv6(ip: string): Uint8Array | null {
  // Strip a zone id and any IPv4 suffix, then expand "::".
  let value = ip.split('%')[0]

  const lastColon = value.lastIndexOf(':')
  const tail = value.slice(lastColon + 1)
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail)
    if (!v4) return null
    value = `${value.slice(0, lastColon + 1)}${hex4(v4[0])}:${hex4(v4[1])}`
  }

  const halves = value.split('::')
  if (halves.length > 2) return null

  const head = halves[0] ? halves[0].split(':') : []
  const rear = halves.length === 2 && halves[1] ? halves[1].split(':') : []

  const missing = 8 - head.length - rear.length
  if (halves.length === 1 && missing !== 0) return null
  if (missing < 0) return null

  const groups = [...head, ...Array<string>(missing).fill('0'), ...rear]
  if (groups.length !== 8) return null

  const out = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    const n = parseInt(groups[i], 16)
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null
    out[i * 2] = n >> 8
    out[i * 2 + 1] = n & 0xff
  }
  return out
}

function hex4(n: number): string {
  return n.toString(16).padStart(2, '0')
}

function parseCidr(entry: string): Cidr | null {
  const trimmed = entry.trim()
  if (!trimmed) return null

  const slash = trimmed.indexOf('/')
  const addr = slash === -1 ? trimmed : trimmed.slice(0, slash)
  const bytes = parseIp(addr)
  if (!bytes) return null

  const maxBits = bytes.length * 8
  const prefixBits = slash === -1 ? maxBits : Number(trimmed.slice(slash + 1))
  if (!Number.isInteger(prefixBits) || prefixBits < 0 || prefixBits > maxBits) return null

  return { bytes, prefixBits }
}

function matches(cidr: Cidr, ip: Uint8Array): boolean {
  if (cidr.bytes.length !== ip.length) return false

  const fullBytes = cidr.prefixBits >> 3
  const remainingBits = cidr.prefixBits & 7

  for (let i = 0; i < fullBytes; i++) {
    if (cidr.bytes[i] !== ip[i]) return false
  }

  if (remainingBits === 0) return true

  const mask = (0xff << (8 - remainingBits)) & 0xff
  return (cidr.bytes[fullBytes] & mask) === (ip[fullBytes] & mask)
}

/**
 * True when `ip` falls inside any of the comma-separated CIDRs/addresses.
 * Unknown or malformed input returns false (fail closed).
 */
export function isIpAllowed(ip: string | null, allowlist: string): boolean {
  if (!ip) return false

  const parsed = parseIp(ip.trim())
  if (!parsed) return false

  return allowlist
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .some((entry) => {
      const cidr = parseCidr(entry)
      return cidr !== null && matches(cidr, parsed)
    })
}

/**
 * Resolves the real client IP.
 *
 * On Cloudflare, CF-Connecting-IP is set by the edge and cannot be spoofed by
 * the caller, so it is preferred. X-Forwarded-For is only trusted as a fallback
 * (e.g. behind another proxy) because it is trivially forged.
 */
export function getClientIp(request: Request): string | null {
  return (
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('X-Real-IP') ??
    firstForwardedFor(request.headers.get('X-Forwarded-For')) ??
    null
  )
}

function firstForwardedFor(header: string | null): string | null {
  if (!header) return null
  const first = header.split(',')[0]?.trim()
  return first || null
}