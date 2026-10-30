// Stores a hash of the sign-up address (never the address itself), keyed by email, so the
// referral reward check can spot several sign-ups from one place. Called before signUp.
// Always answers ok, so the response does not reveal anything about stored emails.
import { NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { createServiceClient } from '@/lib/supabase/service'

export const dynamic = 'force-dynamic'

const KEEP_DAYS = 30

export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return NextResponse.json({ ok: true })

  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown'
  const ipHash = createHash('sha256')
    .update(`signup|${ip}|${process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''}`)
    .digest('hex')

  const svc = createServiceClient()
  await svc.from('signup_visits').upsert({ email, ip_hash: ipHash, created_at: new Date().toISOString() })
  await svc
    .from('signup_visits')
    .delete()
    .lt('created_at', new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString())
  return NextResponse.json({ ok: true })
}
