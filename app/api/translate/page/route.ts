// Translates one catalog page: the model reads the page image, then writes it out in the target language.
// Called once per page by the owner's translation screen (keeps each request short).
import 'server-only'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { resolvePageUrls } from '@/lib/flipbook/sign'
import { FREE_TRANSLATE_PAGES, TRANSLATE_LANGS, isTranslateLang } from '@/lib/translate/languages'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MODEL = process.env.ANTHROPIC_TRANSLATE_MODEL || 'claude-sonnet-5-5'
const MEDIA_TYPES = ['image/webp', 'image/jpeg', 'image/png'] as const

export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return NextResponse.json({ error: '번역 기능을 아직 준비 중이에요' }, { status: 503 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: '로그인이 필요해요' }, { status: 401 })

  const body = (await req.json().catch(() => null)) as { flipbook_id?: string; lang?: unknown; page_no?: unknown } | null
  const flipbookId = body?.flipbook_id
  const pageNo = Number(body?.page_no)
  if (!flipbookId || !isTranslateLang(body?.lang) || !Number.isInteger(pageNo) || pageNo < 1) {
    return NextResponse.json({ error: '요청을 확인해 주세요' }, { status: 400 })
  }
  const lang = body!.lang as keyof typeof TRANSLATE_LANGS

  // The catalog must be visible to this user (owner or team member, enforced by RLS).
  const { data: book } = await supabase.from('flipbooks').select('id').eq('id', flipbookId).maybeSingle()
  if (!book) return NextResponse.json({ error: '자료를 찾을 수 없어요' }, { status: 404 })

  const svc = createServiceClient()

  // Already translated: return it without charging again.
  const { data: existing } = await svc
    .from('flipbook_translations')
    .select('page_text')
    .eq('flipbook_id', flipbookId)
    .eq('lang', lang)
    .eq('page_no', pageNo)
    .maybeSingle()
  if (existing) return NextResponse.json({ text: existing.page_text, charged: false })

  const { count: used } = await svc
    .from('translation_usage')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
  if ((used ?? 0) >= FREE_TRANSLATE_PAGES) {
    return NextResponse.json({ error: `무료 번역 한도(${FREE_TRANSLATE_PAGES}쪽)를 모두 사용했어요` }, { status: 402 })
  }

  const { data: pageRow } = await svc
    .from('flipbook_pages')
    .select('image_url')
    .eq('flipbook_id', flipbookId)
    .eq('page_no', pageNo)
    .maybeSingle()
  if (!pageRow) return NextResponse.json({ error: '해당 쪽이 없어요' }, { status: 404 })

  const [imageUrl] = await resolvePageUrls([pageRow.image_url])
  const imageRes = await fetch(imageUrl)
  if (!imageRes.ok) return NextResponse.json({ error: '쪽 이미지를 읽지 못했어요' }, { status: 502 })
  const contentType = (imageRes.headers.get('content-type') || '').split(';')[0]
  const mediaType = (MEDIA_TYPES as readonly string[]).includes(contentType) ? contentType : 'image/jpeg'
  const data = Buffer.from(await imageRes.arrayBuffer()).toString('base64')

  const prompt =
    `이 카탈로그 페이지의 글자를 모두 읽고 ${TRANSLATE_LANGS[lang].name}로 번역해 주세요. ` +
    '상품명, 모델 번호, 가격, 단위, 숫자는 원문 그대로 두세요. ' +
    '설명 없이 번역문만 출력하세요. 글자가 없으면 "(글자 없음)"이라고만 답하세요.'

  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
            { type: 'text', text: prompt },
          ],
        },
      ],
    }),
  })
  if (!aiRes.ok) return NextResponse.json({ error: '번역하지 못했어요. 잠시 후 다시 해 주세요.' }, { status: 502 })
  const out = (await aiRes.json()) as { content?: { type: string; text?: string }[] }
  const text = (out.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('').trim().slice(0, 8000)
  if (!text) return NextResponse.json({ error: '번역 결과가 비어 있어요' }, { status: 502 })

  await svc.from('flipbook_translations').upsert(
    { flipbook_id: flipbookId, lang, page_no: pageNo, page_text: text },
    { onConflict: 'flipbook_id,lang,page_no' }
  )
  await svc.from('translation_usage').insert({ user_id: user.id, flipbook_id: flipbookId, lang, page_no: pageNo })

  return NextResponse.json({ text, charged: true })
}
