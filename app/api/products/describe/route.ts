// Writes a short shopping description for one product, using only the product's own fields.
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MODEL = process.env.ANTHROPIC_TRANSLATE_MODEL || 'claude-sonnet-5-5'
const UUID = /^[0-9a-f-]{36}$/i

export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'AI 설명 쓰기는 아직 준비 중이에요' }, { status: 503 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: '로그인이 필요해요' }, { status: 401 })

  const body = (await req.json().catch(() => null)) as { product_id?: string } | null
  if (!body?.product_id || !UUID.test(body.product_id)) {
    return NextResponse.json({ error: '요청을 확인해 주세요' }, { status: 400 })
  }

  // Read and write through the owner's session, so the table's own policy decides access.
  const { data: product } = await supabase
    .from('catalog_products').select('id, name, price, unit, options').eq('id', body.product_id).maybeSingle()
  if (!product) return NextResponse.json({ error: '상품을 찾을 수 없어요' }, { status: 404 })

  const facts = [
    `상품명: ${product.name}`,
    product.price !== null ? `가격: ${product.price}원` : '가격: 없음',
    product.unit ? `단위: ${product.unit}` : null,
    product.options ? `옵션: ${product.options}` : null,
  ].filter(Boolean).join('\n')
  const prompt =
    '아래 상품 정보만 보고 쇼핑 화면에 쓸 한국어 소개 문장을 1~2문장으로 쓰세요. ' +
    '정보에 없는 소재, 효능, 인증, 할인, 납기는 절대 지어내지 마세요. 설명 본문만 답하세요.\n\n' + facts

  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 200, messages: [{ role: 'user', content: prompt }] }),
  })
  if (!aiRes.ok) return NextResponse.json({ error: '설명을 쓰지 못했어요. 잠시 후 다시 해 주세요.' }, { status: 502 })
  const out = (await aiRes.json()) as { content?: { type: string; text?: string }[] }
  const description = (out.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('').trim().slice(0, 500)
  if (!description) return NextResponse.json({ error: '설명을 쓰지 못했어요. 잠시 후 다시 해 주세요.' }, { status: 502 })

  const { error } = await supabase.from('catalog_products').update({ description }).eq('id', product.id)
  if (error) return NextResponse.json({ error: '저장하지 못했어요' }, { status: 500 })
  return NextResponse.json({ description })
}
