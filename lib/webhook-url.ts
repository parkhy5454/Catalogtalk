// Checks a CRM webhook address before we send anything to it. Pure function, usable in the browser too.
// Only https, no credentials, no localhost or private IPv4 addresses. IPv6 literals are refused.
export function isSafeWebhookUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'https:') return false
  if (u.username || u.password) return false
  const h = u.hostname.toLowerCase()
  if (!h || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false
  if (h.includes(':')) return false
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const [a, b] = h.split('.').map(Number)
    if (a === 0 || a === 10 || a === 127) return false
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
  }
  return true
}
