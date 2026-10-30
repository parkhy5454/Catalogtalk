// Emails the publisher once per new order request. Only orders not yet announced are sent.
import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { sendEmails } from '@/lib/notify/send'
import { SITE_URL } from '@/lib/site'

export const dynamic = 'force-dynamic'

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))

export async function POST(req: Request) {
  let body: { flipbook_id?: string; session?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 })
  }
  const flipbookId = body.flipbook_id
  const session = body.session
  if (!flipbookId || !session || session.length < 8 || session.length > 64) {
    return NextResponse.json({ ok: false }, { status: 400 })
  }

  const svc = createServiceClient()
  const { data: order } = await svc
    .from('orders')
    .select('id, owner_id, flipbook_id, buyer_name, buyer_contact, buyer_company, items, total, delivery_date')
    .eq('flipbook_id', flipbookId)
    .eq('session_id', session)
    .is('owner_notified_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!order) return NextResponse.json({ ok: true, sent: false })

  const [{ data: book }, { data: owner }] = await Promise.all([
    svc.from('flipbooks').select('title').eq('id', order.flipbook_id).maybeSingle(),
    svc.auth.admin.getUserById(order.owner_id as string),
  ])
  const to = owner?.user?.email
  let sent = false
  if (to) {
    const items = (order.items as { name: string; qty: number; option?: string | null }[])
      .map((i) => `<li>${esc(i.name)}${i.option ? ` (${esc(i.option)})` : ''} × ${i.qty}</li>`)
      .join('')
    const html =
      `<div style="font-family:system-ui,sans-serif;line-height:1.7;color:#111">` +
      `<p><strong>${esc(order.buyer_company ? `${order.buyer_company} · ` : '')}${esc(order.buyer_name)}</strong>님이 주문 요청을 보냈어요.</p>` +
      `<p>연락처: ${esc(order.buyer_contact)}${order.delivery_date ? `<br>희망 납기: ${esc(String(order.delivery_date))}` : ''}</p>` +
      `<ul>${items}</ul>` +
      `<p><a href="${SITE_URL}/dashboard/orders/${order.flipbook_id}">주문 요청 확인하기</a></p></div>`
    const r = await sendEmails([{ to, subject: `[${book?.title ?? '카탈로그'}] 새 주문 요청`, html }])
    sent = r.ok === 1
  }
  // Mark as announced even if the email failed, so the same order is not retried forever.
  await svc.from('orders').update({ owner_notified_at: new Date().toISOString() }).eq('id', order.id)
  return NextResponse.json({ ok: true, sent })
}
