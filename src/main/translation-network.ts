function privateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [first, second] = parts
  return first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
}

function privateIpv6(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  return /^fe[89ab]/.test(normalized)
}

export function isPrivateNetworkUrl(value: string): boolean {
  const hostname = new URL(value).hostname.toLowerCase()
  return hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    !hostname.includes('.') ||
    privateIpv4(hostname) ||
    privateIpv6(hostname)
}
