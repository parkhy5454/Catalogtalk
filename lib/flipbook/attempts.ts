// Limits wrong viewer-password tries per catalog and per visitor address.
// Stored in the database because serverless instances do not share memory.
import 'server-only'
import { createHash } from 'crypto'
import { createServiceClient } from '@/lib/supabase/service'

const MAX_FAILS = 5
const LOCK_MINUTES = 15

export function attemptKey(slug: string, ip: string): string {
  return createHash('sha256').update(`${slug}|${ip}`).digest('hex')
}

/** Returns the time the lock ends, or null when the visitor may try. */
export async function lockedUntil(key: string): Promise<Date | null> {
  const { data } = await createServiceClient()
    .from('unlock_attempts')
    .select('locked_until')
    .eq('key', key)
    .maybeSingle()
  if (!data?.locked_until) return null
  const until = new Date(data.locked_until)
  return until.getTime() > Date.now() ? until : null
}

export async function recordFailure(key: string): Promise<void> {
  const svc = createServiceClient()
  const { data } = await svc.from('unlock_attempts').select('fails').eq('key', key).maybeSingle()
  const fails = (data?.fails ?? 0) + 1
  const lock = fails >= MAX_FAILS
  await svc.from('unlock_attempts').upsert({
    key,
    fails: lock ? 0 : fails,
    locked_until: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null,
  })
}

export async function clearFailures(key: string): Promise<void> {
  await createServiceClient().from('unlock_attempts').delete().eq('key', key)
}
