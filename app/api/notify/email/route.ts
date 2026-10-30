// Sends one notice email to every lead of a catalog who agreed to marketing and gave an email address.
// Uses Resend's batch endpoint (100 per call). Each email carries a one-click 수신거부 link.
import 'server-only'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { SITE_NAME, SITE_URL } from '@/lib/site'
import { EMAIL_BATCH, FREE_EMAIL_SENDS, MAX_RECIPIENTS_PER_REQUEST } from '@/lib/notify/limits'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

export async function POST(req: Request) {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.NOTIFY_FROM_EMAIL
  if (!apiKey || !from) return NextResponse.json({ error: '이메일 발송을 아직 준비 중이에요' }, { status: 503 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: '로그인이 필요해요' }, { status: 401 })

  const body = (await req.json().catch(() => null)) as { flipbook_id?: string; subject?: string; message?: string } | null
  const flipbookId = body?.flipbook_id ?? ''
  const subject = (body?.subject ?? '').trim()
  const message = (body?.message ?? '').trim()
  if (!flipbookId || subject.length < 1 || subject.length > 80 || message.length < 1 || message.length > 1000) {
    return NextResponse.json({ error: '제목(80자 이하)과 내용(1000자 이하)을 입력해 주세요' }, { status: 400 })
  }

  // The catalog must be visible to this user (owner or team member).
  const { data: book } = await supabase.from('flipbooks').select('id, title, slug').eq('id', flipbookId).maybeSingle()
  if (!book) return NextResponse.json({ error: '자료를 찾을 수 없어요' }, { status: 404 })

  const svc = createServiceClient()

  const { data: sent } = await svc.from('notify_sends').select('recipient_count').eq('owner_id', user.id)
  const usedTotal = (sent ?? []).reduce((s, r) => s + (r.recipient_count as number), 0)
  if (usedTotal >= FREE_EMAIL_SENDS) {
    return NextResponse.json({ error: `무료 이메일 한도(${FREE_EMAIL_SENDS}통)를 모두 사용했어요` }, { status: 402 })
  }

  const { data: leads } = await svc
    .from('flipbook_leads')
    .select('id, contact, unsubscribe_token')
    .eq('flipbook_id', flipbookId)
    .eq('marketing_consent', true)
    .limit(MAX_RECIPIENTS_PER_REQUEST * 2)

  // One email per address; phone numbers are skipped here (SMS comes later).
  const seen = new Set<string>()
  const recipients = (leads ?? []).filter((l) => {
    const addr = String(l.contact).trim().toLowerCase()
    if (!EMAIL_RE.test(addr) || seen.has(addr)) return false
    seen.add(addr)
    return true
  })
  const limit = Math.min(recipients.length, Math.max(0, FREE_EMAIL_SENDS - usedTotal), MAX_RECIPIENTS_PER_REQUEST)
  const targets = recipients.slice(0, limit)
  if (targets.length === 0) {
    return NextResponse.json({ error: '이메일로 받을 수 있는 동의자가 없어요' }, { status: 400 })
  }

  const html = (token: string) =>
    `<div style="font-family:system-ui,sans-serif;line-height:1.7;color:#111">` +
    `<p>${esc(message).replace(/\n/g, '<br>')}</p>` +
    `<p><a href="${SITE_URL}/api/mail/click?t=${token}&k=notice">${esc(book.title)} 보러 가기</a></p>` +
    `<hr style="border:none;border-top:1px solid #eee;margin:24px 0">` +
    `<p style="font-size:12px;color:#777">이 메일은 ${esc(book.title)} 자료를 보신 분 중 소식 수신에 동의하신 분께 보내드려요. ` +
    `더 받고 싶지 않으시면 <a href="${SITE_URL}/api/unsubscribe?t=${token}">수신거부</a>를 눌러 주세요. (${SITE_NAME})</p></div>`

  const emails = targets.map((t) => ({
    from,
    to: [String(t.contact).trim()],
    subject,
    html: html(t.unsubscribe_token as string),
  }))

  let ok = 0
  let failed = 0
  const sentLeadIds: string[] = []
  for (let i = 0; i < emails.length; i += EMAIL_BATCH) {
    const chunk = emails.slice(i, i + EMAIL_BATCH)
    try {
      const res = await fetch('https://api.resend.com/emails/batch', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk),
      })
      if (res.ok) {
        ok += chunk.length
        sentLeadIds.push(...targets.slice(i, i + EMAIL_BATCH).map((t) => t.id as string))
      } else failed += chunk.length
    } catch {
      failed += chunk.length
    }
  }

  // Send history per customer (shown on the customer screen).
  if (sentLeadIds.length > 0) {
    await svc.from('lead_sends').insert(sentLeadIds.map((lead_id) => ({ lead_id, flipbook_id: flipbookId, kind: 'notice' })))
  }

  const status = failed === 0 ? 'sent' : ok === 0 ? 'failed' : 'partial'
  await svc.from('notify_sends').insert({
    flipbook_id: flipbookId,
    owner_id: user.id,
    channel: 'email',
    subject,
    recipient_count: ok,
    status,
  })

  return NextResponse.json({ ok: true, sent: ok, failed, skipped: recipients.length - targets.length, status })
}
