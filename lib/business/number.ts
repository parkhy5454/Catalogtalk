// Korean business registration number (사업자등록번호): 10 digits with a check digit.
// Format and check digit only; it does not confirm the business is open (no tax-office lookup).
const WEIGHTS = [1, 3, 7, 1, 3, 7, 1, 3, 5]

/** Returns the 10 digits when valid, otherwise null. */
export function normalizeBusinessNumber(raw: string): string | null {
  const d = raw.replace(/\D/g, '')
  if (d.length !== 10) return null
  let sum = 0
  for (let i = 0; i < 9; i++) sum += Number(d[i]) * WEIGHTS[i]
  sum += Math.floor((Number(d[8]) * 5) / 10)
  const check = (10 - (sum % 10)) % 10
  return check === Number(d[9]) ? d : null
}
