// Drafts a follow-up message for one lead, using only what the owner can already see in the sales view.
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { SALES_AI_FREE_MONTHLY } from '@/lib/sales/limits'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MODEL = process.env.ANTHROPIC_TRANSLATE_MODEL || 'claude-sonnet-5-5'
const UUID = /^[0-9a-f-]{36}$/i

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: '로그인이 필요해요' }, { status: 401 })

  let body: { flipbook_id?: string; lead_id?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: '잘못된 요청이에요' }, { status: 400 })
  }
  if (!body.flipbook_id || !body.lead_id || !UUID.test(body.flipbook_id) || !UUID.test(body.lead_id)) {
    return NextResponse.json({ error: '잘못된 요청이에요' }, { status: 400 })
  }

  // Reading through the user's session means RLS and the owner check apply.
  const [{ data: book }, { data: rows }] = await Promise.all([
    supabase.from('flipbooks').select('title').eq('id', body.flipbook_id).maybeSingle(),
    supabase.rpc('get_buyer_intent', { p_flipbook: body.flipbook_id }),
  ])
  const lead = (rows as { lead_id: string; lead_name: string; tier: string; score: number; ordered: boolean; asked: boolean; dwell_ms: number; viewed_products: string[] }[] | null)
    ?.find((r) => r.lead_id === body.lead_id)
  if (!book || !lead) return NextResponse.json({ error: '고객을 찾을 수 없어요' }, { status: 404 })

  const svc = createServiceClient()
  const month = new Date().toISOString().slice(0, 7)
  const { data: usage } = await svc
    .from('ai_sales_usage').select('count').eq('user_id', user.id).eq('month', month).maybeSingle()
  const used = (usage?.count as number | undefined) ?? 0
  if (used >= SALES_AI_FREE_MONTHLY) {
    return NextResponse.json({ error: `이번 달 무료 초안(${SALES_AI_FREE_MONTHLY}건)을 모두 썼어요` }, { status: 429 })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return NextResponse.json({ error: '지금은 초안을 만들 수 없어요' }, { status: 503 })

  const tierLabel = lead.tier === 'hot' ? '구매 가능성 높음' : lead.tier === 'warm' ? '관심 있음' : '둘러보는 중'
  const facts = [
    `카탈로그: ${book.title}`,
    `고객 이름: ${lead.lead_name || '고객'}`,
    `분류: ${tierLabel}`,
    `주문 요청: ${lead.ordered ? '있음' : '없음'}, 견적 요청: ${lead.asked ? '있음' : '없음'}`,
    `본 시간: 약 ${Math.max(1, Math.round(lead.dwell_ms / 60000))}분`,
    `오래 본 상품: ${lead.viewed_products?.length ? lead.viewed_products.join(', ') : '특정 상품 없음'}`,
  ].join('\n')
  const prompt =
    '아래 정보를 바탕으로 판매자가 고객에게 보낼 짧은 후속 메시지 초안을 한국어로 써 주세요. ' +
    '3~4문장, 정중하고 부담 없는 말투로 쓰고, 질문 하나로 끝내세요. ' +
    '가격, 할인, 납기, 재고처럼 확인되지 않은 내용은 절대 쓰지 마세요. 메시지 본문만 답하세요.\n\n' + facts

  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 500, messages: [{ role: 'user', content: prompt }] }),
  })
  if (!aiRes.ok) return NextResponse.json({ error: '초안을 만들지 못했어요. 잠시 후 다시 해 주세요.' }, { status: 502 })
  const out = (await aiRes.json()) as { content?: { type: string; text?: string }[] }
  const draft = (out.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('').trim()
  if (!draft) return NextResponse.json({ error: '초안을 만들지 못했어요. 잠시 후 다시 해 주세요.' }, { status: 502 })

  await svc.from('ai_sales_usage').upsert({ user_id: user.id, month, count: used + 1 }, { onConflict: 'user_id,month' })
  return NextResponse.json({ draft, used: used + 1, limit: SALES_AI_FREE_MONTHLY })
}
