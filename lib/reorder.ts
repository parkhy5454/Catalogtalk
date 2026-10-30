// Reorder reminders: for each catalog with a reminder setting, email buyers whose latest order is older
// than the chosen number of days. Only buyers who agreed to marketing (kept as leads) are emailed.
// Each order gets at most one reminder (reorder_reminders).
import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { SITE_NAME, SITE_URL } from '@/lib/site'
import { sendEmails } from '@/lib/notify/send'

const MAX_PER_RUN = 500
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

export async function sendReorderReminders(): Promise<{ sent: number; failed: number }> {
  const svc = createServiceClient()
  const { data: books } = await svc
    .from('flipbooks')
    .select('id, title, slug, reorder_days, order_requires_subscription')
    .not('reorder_days', 'is', null)
  let sent = 0
  let failed = 0

  for (const b of books ?? []) {
    if (sent + failed >= MAX_PER_RUN) break
    const days = b.reorder_days as number
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000

    const { data: orders } = await svc
      .from('orders')
      .select('id, buyer_contact, created_at')
      .eq('flipbook_id', b.id)
      .order('created_at', { ascending: false })
      .limit(2000)

    // Latest order per buyer.
    const latest = new Map<string, { id: string; created_at: string }>()
    for (const o of orders ?? []) {
      const key = String(o.buyer_contact).trim().toLowerCase()
      if (!latest.has(key)) latest.set(key, { id: o.id as string, created_at: o.created_at as string })
    }

    let due = Array.from(latest.entries()).filter(([, o]) => new Date(o.created_at).getTime() <= cutoff)
    if (b.order_requires_subscription && due.length > 0) {
      // Subscription-only catalogs: remind only buyers with an active subscription.
      const { data: subs } = await svc
        .from('buyer_subscriptions').select('contact')
        .eq('flipbook_id', b.id).eq('status', 'active').gt('current_period_end', new Date().toISOString())
      const subscribed = new Set((subs ?? []).map((r) => String(r.contact)))
      due = due.filter(([contact]) => subscribed.has(contact))
    }
    if (due.length === 0) continue

    const { data: already } = await svc
      .from('reorder_reminders').select('order_id').in('order_id', due.map(([, o]) => o.id))
    const sentOrders = new Set((already ?? []).map((r) => r.order_id as string))

    const { data: leads } = await svc
      .from('flipbook_leads')
      .select('contact, unsubscribe_token, marketing_consent')
      .eq('flipbook_id', b.id)
      .eq('marketing_consent', true)
    const consentTokens = new Map<string, string>()
    for (const l of leads ?? []) consentTokens.set(String(l.contact).trim().toLowerCase(), l.unsubscribe_token as string)

    const batch: { to: string; subject: string; html: string; orderId: string }[] = []
    for (const [contact, o] of due) {
      if (sentOrders.has(o.id)) continue
      if (!EMAIL_RE.test(contact)) continue
      const token = consentTokens.get(contact)
      if (!token) continue
      if (sent + failed + batch.length >= MAX_PER_RUN) break
      batch.push({
        to: contact,
        orderId: o.id,
        subject: `${b.title} 재주문 안내`,
        html:
          `<div style="font-family:system-ui,sans-serif;line-height:1.7;color:#111">` +
          `<p>지난번 주문하셨던 상품을 다시 찾으실 때가 되었어요.</p>` +
          `<p><a href="${SITE_URL}/b/${b.slug}">${esc(b.title)} 다시 보기</a></p>` +
          `<hr style="border:none;border-top:1px solid #eee;margin:24px 0">` +
          `<p style="font-size:12px;color:#777">이 메일은 주문하신 분 중 소식 수신에 동의하신 분께 보내드려요. ` +
          `더 받고 싶지 않으시면 <a href="${SITE_URL}/api/unsubscribe?t=${token}">수신거부</a>를 눌러 주세요. (${SITE_NAME})</p></div>`,
      })
    }
    if (batch.length === 0) continue

    const result = await sendEmails(batch.map(({ to, subject, html }) => ({ to, subject, html })))
    // Mark only the orders whose email was accepted by Resend.
    const markIds = batch.filter((_, i) => result.accepted[i]).map((m) => m.orderId)
    if (markIds.length > 0) {
      await svc.from('reorder_reminders').insert(markIds.map((order_id) => ({ order_id, flipbook_id: b.id })))
    }
    sent += result.ok
    failed += result.failed
  }

  return { sent, failed }
}
