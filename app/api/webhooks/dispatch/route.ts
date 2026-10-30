// Sends pending CRM webhook deliveries. Called right after a lead or quote is saved, and from the
// integrations screen ("다시 보내기"). Safe to call often: each delivery is claimed before sending.
// Failed sends retry after 1, 10, 60, 360 and 1440 minutes, then stop (6 attempts in total).
import 'server-only'
import { createHmac } from 'crypto'
import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { isSafeWebhookUrl } from '@/lib/webhook-url'

export const dynamic = 'force-dynamic'

const RETRY_MINUTES = [1, 10, 60, 360, 1440]
const BATCH = 50
const CLAIM_MINUTES = 5 // while a delivery is being sent, others skip it for this long

type Due = {
  id: string
  event: string
  payload: unknown
  attempts: number
  next_attempt_at: string
  webhook_endpoints: { url: string; secret: string; enabled: boolean } | null
}

export async function POST() {
  const svc = createServiceClient()
  const nowIso = new Date().toISOString()
  const { data, error } = await svc
    .from('webhook_deliveries')
    .select('id, event, payload, attempts, next_attempt_at, webhook_endpoints(url, secret, enabled)')
    .eq('status', 'pending')
    .lte('next_attempt_at', nowIso)
    .order('next_attempt_at', { ascending: true })
    .limit(BATCH)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  let delivered = 0
  let retrying = 0
  let failed = 0

  for (const row of (data ?? []) as unknown as Due[]) {
    const ep = row.webhook_endpoints
    // Claim: move the next attempt forward so a parallel call skips this row.
    const lease = new Date(Date.now() + CLAIM_MINUTES * 60_000).toISOString()
    const { data: claimed } = await svc
      .from('webhook_deliveries')
      .update({ next_attempt_at: lease })
      .eq('id', row.id)
      .eq('status', 'pending')
      .eq('next_attempt_at', row.next_attempt_at)
      .select('id')
    if (!claimed || claimed.length === 0) continue

    if (!ep || !ep.enabled) {
      await svc.from('webhook_deliveries').update({ status: 'failed', last_error: '연동이 꺼져 있거나 삭제됐어요' }).eq('id', row.id)
      failed++
      continue
    }

    const body = JSON.stringify(row.payload)
    const ts = Math.floor(Date.now() / 1000).toString()
    const signature = 'sha256=' + createHmac('sha256', ep.secret).update(`${ts}.${body}`).digest('hex')

    let code: number | null = null
    let sendError: string | null = null
    if (!isSafeWebhookUrl(ep.url)) {
      sendError = '안전하지 않은 주소라 보내지 않았어요'
    } else {
      try {
        const res = await fetch(ep.url, {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'CatalogTalk-Webhook/1',
            'X-Catalogtalk-Event': row.event,
            'X-Catalogtalk-Event-Id': row.id,
            'X-Catalogtalk-Timestamp': ts,
            'X-Catalogtalk-Signature': signature,
          },
          body,
        })
        code = res.status
        if (!res.ok) sendError = `HTTP ${res.status}`
      } catch (e) {
        sendError = e instanceof Error ? e.message.slice(0, 200) : '연결하지 못했어요'
      }
    }

    const attempts = row.attempts + 1
    if (!sendError) {
      await svc
        .from('webhook_deliveries')
        .update({ status: 'delivered', attempts, last_code: code, last_error: null, delivered_at: new Date().toISOString() })
        .eq('id', row.id)
      delivered++
    } else if (attempts > RETRY_MINUTES.length) {
      await svc
        .from('webhook_deliveries')
        .update({ status: 'failed', attempts, last_code: code, last_error: sendError })
        .eq('id', row.id)
      failed++
    } else {
      const next = new Date(Date.now() + RETRY_MINUTES[attempts - 1] * 60_000).toISOString()
      await svc
        .from('webhook_deliveries')
        .update({ attempts, last_code: code, last_error: sendError, next_attempt_at: next })
        .eq('id', row.id)
      retrying++
    }
  }

  return NextResponse.json({ ok: true, delivered, retrying, failed })
}
