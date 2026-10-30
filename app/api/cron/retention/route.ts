// Daily job (Vercel Cron): removes view logs and collected leads older than 365 days.
// Only runs when called with the CRON_SECRET bearer token.
import 'server-only'
import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const svc = createServiceClient()
  const [views, leads, hooks] = await Promise.all([
    svc.rpc('purge_old_flipbook_views'),
    svc.rpc('purge_old_leads'),
    svc.rpc('purge_old_webhook_deliveries'),
  ])
  const error = views.error?.message ?? leads.error?.message ?? hooks.error?.message
  if (error) return NextResponse.json({ error }, { status: 500 })

  return NextResponse.json({ ok: true, views: views.data ?? 0, leads: leads.data ?? 0, webhooks: hooks.data ?? 0 })
}
