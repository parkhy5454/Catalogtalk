// Reads one catalog page and lists the products on it (name, price, unit, options, short description).
// Called once per page by the owner's product screen. The owner checks and fixes the result.
import 'server-only'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { resolvePageUrls } from '@/lib/flipbook/sign'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MODEL = process.env.ANTHROPIC_TRANSLATE_MODEL || 'claude-sonnet-5-5'
const MEDIA_TYPES = ['image/webp', 'image/jpeg', 'image/png'] as const
const MAX_PRODUCTS_PER_PAGE = 40
const MAX_PRODUCTS_PER_CATALOG = 1000

type Extracted = {
  name: string
  price: number | null
  unit: string | null
  options: string | null
  description: string | null
  bbox: [number, number, number, number] | null
}

function cut(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t.slice(0, max) : null
}

// Keeps a photo box only when it is four numbers in 0..1 with a positive size.
function cleanBbox(v: unknown): [number, number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 4) return null
  const n = v.map((x) => (typeof x === 'number' ? x : Number.NaN))
  if (n.some((x) => !Number.isFinite(x) || x < 0 || x > 1)) return null
  const [x, y, w, h] = n
  if (w <= 0 || h <= 0 || x + w > 1.001 || y + h > 1.001) return null
  return [x, y, w, h].map((x) => Math.round(x * 10000) / 10000) as [number, number, number, number]
}

function parseProducts(text: string): Extracted[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: Extracted[] = []
  for (const r of raw.slice(0, MAX_PRODUCTS_PER_PAGE)) {
    const o = r as Record<string, unknown>
    const name = cut(o.name, 120)
    if (!name) continue
    const priceNum = typeof o.price === 'number' ? o.price : Number(String(o.price ?? '').replace(/[^0-9.]/g, ''))
    out.push({
      name,
      price: Number.isFinite(priceNum) && priceNum >= 0 ? Math.round(priceNum) : null,
      unit: cut(o.unit, 20),
      options: cut(o.options, 300),
      description: cut(o.description, 500),
      bbox: cleanBbox(o.bbox),
    })
  }
  return out
}

export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'AI 상품 읽기는 아직 준비 중이에요' }, { status: 503 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: '로그인이 필요해요' }, { status: 401 })

  const body = (await req.json().catch(() => null)) as { flipbook_id?: string; page_no?: unknown } | null
  const flipbookId = body?.flipbook_id ?? ''
  const pageNo = Number(body?.page_no)
  if (!flipbookId || !Number.isInteger(pageNo) || pageNo < 1) {
    return NextResponse.json({ error: '요청을 확인해 주세요' }, { status: 400 })
  }

  const { data: book } = await supabase.from('flipbooks').select('id').eq('id', flipbookId).maybeSingle()
  if (!book) return NextResponse.json({ error: '자료를 찾을 수 없어요' }, { status: 404 })

  const svc = createServiceClient()
  const { count: total } = await svc
    .from('catalog_products').select('id', { count: 'exact', head: true }).eq('flipbook_id', flipbookId)
  if ((total ?? 0) >= MAX_PRODUCTS_PER_CATALOG) {
    return NextResponse.json({ error: `상품은 자료당 ${MAX_PRODUCTS_PER_CATALOG}개까지예요` }, { status: 400 })
  }

  const { data: pageRow } = await svc
    .from('flipbook_pages').select('image_url').eq('flipbook_id', flipbookId).eq('page_no', pageNo).maybeSingle()
  if (!pageRow) return NextResponse.json({ error: '해당 쪽이 없어요' }, { status: 404 })

  const [imageUrl] = await resolvePageUrls([pageRow.image_url])
  const imageRes = await fetch(imageUrl)
  if (!imageRes.ok) return NextResponse.json({ error: '쪽 이미지를 읽지 못했어요' }, { status: 502 })
  const contentType = (imageRes.headers.get('content-type') || '').split(';')[0]
  const mediaType = (MEDIA_TYPES as readonly string[]).includes(contentType) ? contentType : 'image/jpeg'
  const data = Buffer.from(await imageRes.arrayBuffer()).toString('base64')

  const prompt =
    '이 카탈로그 페이지에 있는 상품을 모두 찾아 JSON 배열로만 답하세요. 설명이나 다른 글은 쓰지 마세요. ' +
    '각 항목은 {"name": 상품명, "price": 숫자 가격(원, 없으면 null), "unit": 단위 또는 null, ' +
    '"options": 옵션 글 또는 null, "description": 짧은 설명 또는 null, "bbox": 상품 사진이 있는 영역을 쪽 크기 기준 [x, y, 가로, 세로] 비율 숫자 4개(0~1)로 쓰고, 사진이 없으면 null} 형식이에요. ' +
    '상품이 없으면 []만 답하세요. 가격은 원문 숫자를 그대로 쓰고, 확실하지 않은 값은 null로 두세요.'

  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 3000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
          { type: 'text', text: prompt },
        ],
      }],
    }),
  })
  if (!aiRes.ok) return NextResponse.json({ error: '상품을 읽지 못했어요. 잠시 후 다시 해 주세요.' }, { status: 502 })
  const out = (await aiRes.json()) as { content?: { type: string; text?: string }[] }
  const text = (out.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('')

  // The owner screen skips pages that already have products, so a page is not read twice.
  const products = parseProducts(text)
  if (products.length > 0) {
    const rows = products.map((p) => ({ flipbook_id: flipbookId, page_no: pageNo, ...p }))
    const { error } = await svc.from('catalog_products').insert(rows)
    if (error) return NextResponse.json({ error: '저장하지 못했어요' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, count: products.length, products })
}
