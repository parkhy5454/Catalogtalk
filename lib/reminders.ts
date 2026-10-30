// Automated reminder mails (run from the daily job):
//  - unviewed: customers who agreed to marketing and have not opened the catalog for N days
//  - quote_reminder: customers whose quote request has stayed "new" for N days
// Each customer gets at most one mail of a kind per period. Only marketing-consent customers are mailed.
import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { SITE_URL, SITE_NAME } from '@/lib/site'
import { sendEmails } from '@/lib/notify/send'

const MAX_PER_RUN = 300
const DAY = 24 * 60 * 60 * 1000
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

function mailHtml(title: string, lines: string[], token: string, kind: string) {
  const link = `${SITE_URL}/api/mail/click?t=${token}&k=${kind}`
  return (
    `<div style="font-family:system-ui,sans-serif;line-height:1.7;color:#111">` +
    lines.map((l) => `<p>${esc(l)}</p>`).join('') +
    `<p><a href="${link}">${esc(title)} 보러 가기</a></p>` +
    `<hr style="border:none;border-top:1px solid #eee;margin:24px 0">` +
    `<p style="font-size:12px;color:#777">마케팅 수신에 동의하신 분께 보내드려요. 더 받고 싶지 않으시면 ` +
    `<a href="${SITE_URL}/api/unsubscribe?t=${token}">수신거부</a>를 눌러 주세요. (${SITE_NAME})</p></div>`
  )
}

async function sendAndLog(
  svc: ReturnType<typeof createServiceClient>,
  flipbookId: string,
  kind: 'unviewed' | 'quote_reminder',
  items: { leadId: string; to: string; subject: string; html: string }[]
): Promise<{ ok: number; failed: number }> {
  if (items.length === 0) return { ok: 0, failed: 0 }
  const r = await sendEmails(items.map(({ to, subject, html }) => ({ to, subject, html })))
  const ids = items.filter((_, i) => r.accepted[i]).map((m) => m.leadId)
  if (ids.length > 0) {
    await svc.from('lead_sends').insert(ids.map((lead_id) => ({ lead_id, flipbook_id: flipbookId, kind })))
  }
  return { ok: r.ok, failed: r.failed }
}

export async function sendAutomatedReminders(): Promise<{ sent: number; failed: number }> {
  const svc = createServiceClient()
  const { data: books } = await svc
    .from('flipbooks')
    .select('id, title, remind_unviewed_days, remind_quote_days')
    .or('remind_unviewed_days.gt.0,remind_quote_days.gt.0')
  let sent = 0
  let failed = 0

  for (const b of books ?? []) {
    if (sent + failed >= MAX_PER_RUN) break

    // Unviewed: consenting leads with no view in the last N days and no such mail in that period.
    if (b.remind_unviewed_days) {
      const cutoff = new Date(Date.now() - (b.remind_unviewed_days as number) * DAY).toISOString()
      const { data: leads } = await svc
        .from('flipbook_leads')
        .select('id, contact, unsubscribe_token, session_id')
        .eq('flipbook_id', b.id).eq('marketing_consent', true).limit(2000)
      const sessions = (leads ?? []).map((l) => l.session_id).filter((s): s is string => !!s)
      const active = new Set<string>()
      for (let i = 0; i < sessions.length; i += 200) {
        const { data } = await svc.from('flipbook_views').select('session_id')
          .eq('flipbook_id', b.id).in('session_id', sessions.slice(i, i + 200)).gte('viewed_at', cutoff)
        for (const v of data ?? []) if (v.session_id) active.add(v.session_id as string)
      }
      const { data: recent } = await svc.from('lead_sends').select('lead_id')
        .eq('flipbook_id', b.id).eq('kind', 'unviewed').gte('sent_at', cutoff)
      const recentIds = new Set((recent ?? []).map((r) => r.lead_id as string))

      const items: { leadId: string; to: string; subject: string; html: string }[] = []
      for (const l of leads ?? []) {
        if (sent + failed + items.length >= MAX_PER_RUN) break
        const addr = String(l.contact).trim().toLowerCase()
        if (!EMAIL_RE.test(addr) || !l.unsubscribe_token) continue
        if (l.session_id && active.has(l.session_id as string)) continue
        if (recentIds.has(l.id as string)) continue
        items.push({
          leadId: l.id as string,
          to: addr,
          subject: `${b.title} 다시 보기`,
          html: mailHtml(b.title as string, [`${b.title} 자료를 한동안 보지 않으셨네요.`, '새 소식과 상품을 다시 확인해 보세요.'], l.unsubscribe_token as string, 'unviewed'),
        })
      }
      const r = await sendAndLog(svc, b.id as string, 'unviewed', items)
      sent += r.ok
      failed += r.failed
    }

    // Quote reminder: quote requests still "new" after N days, for consenting customers.
    if (b.remind_quote_days && sent + failed < MAX_PER_RUN) {
      const cutoff = new Date(Date.now() - (b.remind_quote_days as number) * DAY).toISOString()
      const { data: quotes } = await svc.from('quote_requests').select('contact')
        .eq('flipbook_id', b.id).eq('status', 'new').lte('created_at', cutoff).limit(500)
      const pending = new Set((quotes ?? []).map((q) => String(q.contact).trim().toLowerCase()))
      if (pending.size > 0) {
        const { data: leads } = await svc.from('flipbook_leads')
          .select('id, contact, unsubscribe_token')
          .eq('flipbook_id', b.id).eq('marketing_consent', true).limit(2000)
        const { data: recent } = await svc.from('lead_sends').select('lead_id')
          .eq('flipbook_id', b.id).eq('kind', 'quote_reminder').gte('sent_at', cutoff)
        const recentIds = new Set((recent ?? []).map((r) => r.lead_id as string))

        const items: { leadId: string; to: string; subject: string; html: string }[] = []
        for (const l of leads ?? []) {
          if (sent + failed + items.length >= MAX_PER_RUN) break
          const addr = String(l.contact).trim().toLowerCase()
          if (!pending.has(addr) || !EMAIL_RE.test(addr) || !l.unsubscribe_token) continue
          if (recentIds.has(l.id as string)) continue
          items.push({
            leadId: l.id as string,
            to: addr,
            subject: `${b.title} 견적 요청 확인 안내`,
            html: mailHtml(b.title as string, ['보내주신 견적 요청을 확인하고 있어요.', '궁금한 점이 있으면 발행자가 곧 연락드릴 거예요.'], l.unsubscribe_token as string, 'quote_reminder'),
          })
        }
        const r = await sendAndLog(svc, b.id as string, 'quote_reminder', items)
        sent += r.ok
        failed += r.failed
      }
    }
  }
  return { sent, failed }
}

