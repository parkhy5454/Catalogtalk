// Korean phone number input: keeps digits only and adds hyphens as the user types.
// 010-1234-5678 (mobile), 02-123-4567 / 02-1234-5678 (Seoul), 031-123-4567 (other areas).
export function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 11)
  if (!digits) return ''
  const areaLen = digits.startsWith('02') ? 2 : 3
  if (digits.length <= areaLen) return digits
  const area = digits.slice(0, areaLen)
  const rest = digits.slice(areaLen)
  // Full numbers split 3-3-4 (10 digits) or 3-4-4 (11 digits); the middle group is 3 or 4.
  const fullLen = areaLen === 2 ? 9 : 10
  const midLen = digits.length <= fullLen ? 3 : 4
  if (rest.length <= midLen) return `${area}-${rest}`
  return `${area}-${rest.slice(0, midLen)}-${rest.slice(midLen)}`
}
