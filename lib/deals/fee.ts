// Fee on a won deal. PLACEHOLDER rate: the real rate is a business and legal decision, to be set
// before any money moves through the platform. Only shown as an estimate for now.
export const PLACEHOLDER_FEE_RATE = 0.03

export function estimateFee(amount: number, rate: number = PLACEHOLDER_FEE_RATE): number {
  return Math.round(amount * rate)
}
