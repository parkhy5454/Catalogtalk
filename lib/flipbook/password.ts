// Flipbook password: scrypt for storing the password, and an HMAC "unlock" cookie per catalog.
// The cookie is bound to the stored hash, so changing or removing the password logs everyone out.
import 'server-only'
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'crypto'

export const UNLOCK_SECONDS = 60 * 60 * 24 // 1 day

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  return `scrypt$${salt}$${scryptSync(password, salt, 32).toString('hex')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, salt, hash] = stored.split('$')
  if (alg !== 'scrypt' || !salt || !hash) return false
  const candidate = scryptSync(password, salt, 32)
  const expected = Buffer.from(hash, 'hex')
  return expected.length === candidate.length && timingSafeEqual(expected, candidate)
}

function secret(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY 환경변수가 없어요')
  return key
}

/** Cookie name per catalog. Hashed so any slug (even non-ASCII) gives a valid cookie name. */
export function cookieName(slug: string): string {
  return 'ct_u_' + createHash('sha256').update(slug).digest('hex').slice(0, 16)
}

export function unlockToken(slug: string, storedHash: string): string {
  return createHmac('sha256', secret()).update(`${slug}|${storedHash}`).digest('hex')
}

export function isUnlockValid(slug: string, storedHash: string, token: string | undefined): boolean {
  if (!token) return false
  const expected = Buffer.from(unlockToken(slug, storedHash))
  const given = Buffer.from(token)
  return given.length === expected.length && timingSafeEqual(given, expected)
}
