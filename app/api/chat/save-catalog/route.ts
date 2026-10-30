// Save a catalog that someone sent in chat into my own My Book, as a full copy.
// The copy is independent: later changes or link-off by the sender do not affect it.
import 'server-only'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { PRIVATE_BUCKET, PRIVATE_PREFIX, PUBLIC_BUCKET, isPrivateRef, privatePathOf } from '@/lib/flipbook/storage'

export const dynamic = 'force-dynamic'

const COPY_CONCURRENCY = 8

type Source = {
  id: string
  user_id: string
  title: string
  slug: string
  pdf_url: string | null
  thumb_url: string | null
  page_count: number
  is_public: boolean | null
  expires_at: string | null
}

// Public URLs look like .../storage/v1/object/public/flipbook-files/<path>; keep only the path.
function pathFromPublicUrl(url: string): string | null {
  const marker = `/${PUBLIC_BUCKET}/`
  const at = url.indexOf(marker)
  if (at < 0) return null
  return url.slice(at + marker.length).split('?')[0]
}

function fileName(path: string) {
  return path.slice(path.lastIndexOf('/') + 1)
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += limit) {
    await Promise.all(items.slice(i, i + limit).map(fn))
  }
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { message_id?: string } | null
  const messageId = body?.message_id
  if (!messageId) return NextResponse.json({ error: '카탈로그를 찾지 못했어요' }, { status: 400 })

  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: '로그인이 필요해요' }, { status: 401 })

  // Reading the message through the user's client proves I am a member of its room (RLS).
  const { data: msg } = await sb
    .from('chat_messages')
    .select('id, sender_id, catalog_slug')
    .eq('id', messageId)
    .maybeSingle()
  if (!msg || !msg.catalog_slug) return NextResponse.json({ error: '카탈로그 메시지가 아니에요' }, { status: 404 })

  const svc = createServiceClient()
  const { data: srcRow } = await svc
    .from('flipbooks')
    .select('id, user_id, title, slug, pdf_url, thumb_url, page_count, is_public, expires_at')
    .eq('slug', msg.catalog_slug)
    .maybeSingle()
  const src = srcRow as Source | null

  // Only the sender's own catalog can be copied, and only while its link is live.
  if (!src || src.user_id !== msg.sender_id) {
    return NextResponse.json({ error: '카탈로그를 찾지 못했어요' }, { status: 404 })
  }
  if (src.is_public === false) return NextResponse.json({ error: '상대가 링크를 끈 카탈로그예요' }, { status: 403 })
  if (src.expires_at && new Date(src.expires_at).getTime() < Date.now()) {
    return NextResponse.json({ error: '기간이 끝난 카탈로그예요' }, { status: 403 })
  }
  if (src.user_id === user.id) return NextResponse.json({ error: '내가 만든 카탈로그예요' }, { status: 400 })

  const newSlug = `catalog-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const copied: { bucket: string; path: string }[] = []

  // The insert runs the plan limit check in the database (PLAN_LIMIT).
  const { data: created, error: insErr } = await svc
    .from('flipbooks')
    .insert({
      user_id: user.id,
      title: src.title,
      slug: newSlug,
      page_count: src.page_count,
      status: 'ready',
    })
    .select('id')
    .single()
  if (insErr || !created) {
    const planMsg = insErr?.message.match(/PLAN_LIMIT:\s*(.*)/)
    return NextResponse.json(
      { error: planMsg ? planMsg[1] : '카탈로그를 저장하지 못했어요' },
      { status: planMsg ? 403 : 500 }
    )
  }

  const rollback = async () => {
    await svc.from('flipbooks').delete().eq('id', created.id)
    for (const c of copied) await svc.storage.from(c.bucket).remove([c.path]).catch(() => undefined)
  }

  try {
    const copyOne = async (fromBucket: string, fromPath: string, toPath: string) => {
      const { error } = await svc.storage.from(fromBucket).copy(fromPath, toPath)
      if (error) throw new Error(error.message)
      copied.push({ bucket: fromBucket, path: toPath })
    }

    // Original file (private, or legacy public).
    let pdfUrl: string | null = null
    if (src.pdf_url) {
      if (isPrivateRef(src.pdf_url)) {
        const from = privatePathOf(src.pdf_url)
        const to = `${newSlug}/${fileName(from)}`
        await copyOne(PRIVATE_BUCKET, from, to)
        pdfUrl = PRIVATE_PREFIX + to
      } else {
        const from = pathFromPublicUrl(src.pdf_url)
        if (from) {
          const to = `${newSlug}/${fileName(from)}`
          await copyOne(PUBLIC_BUCKET, from, to)
          pdfUrl = svc.storage.from(PUBLIC_BUCKET).getPublicUrl(to).data.publicUrl
        }
      }
    }

    // Thumbnail (always public).
    let thumbUrl: string | null = null
    if (src.thumb_url) {
      const from = pathFromPublicUrl(src.thumb_url)
      if (from) {
        const to = `${newSlug}/${fileName(from)}`
        await copyOne(PUBLIC_BUCKET, from, to)
        thumbUrl = svc.storage.from(PUBLIC_BUCKET).getPublicUrl(to).data.publicUrl
      }
    }

    // Page images, keeping each page's storage bucket.
    const { data: pages, error: pageErr } = await svc
      .from('flipbook_pages')
      .select('page_no, image_url')
      .eq('flipbook_id', src.id)
      .order('page_no', { ascending: true })
    if (pageErr) throw new Error(pageErr.message)

    const newPages: { flipbook_id: string; page_no: number; image_url: string }[] = []
    await mapLimit(pages ?? [], COPY_CONCURRENCY, async (p) => {
      if (isPrivateRef(p.image_url)) {
        const from = privatePathOf(p.image_url)
        const to = `${newSlug}/${fileName(from)}`
        await copyOne(PRIVATE_BUCKET, from, to)
        newPages.push({ flipbook_id: created.id, page_no: p.page_no, image_url: PRIVATE_PREFIX + to })
      } else {
        const from = pathFromPublicUrl(p.image_url)
        if (!from) throw new Error('페이지 이미지를 찾지 못했어요')
        const to = `${newSlug}/${fileName(from)}`
        await copyOne(PUBLIC_BUCKET, from, to)
        newPages.push({
          flipbook_id: created.id,
          page_no: p.page_no,
          image_url: svc.storage.from(PUBLIC_BUCKET).getPublicUrl(to).data.publicUrl,
        })
      }
    })

    const { error: updErr } = await svc
      .from('flipbooks')
      .update({ pdf_url: pdfUrl, thumb_url: thumbUrl })
      .eq('id', created.id)
    if (updErr) throw new Error(updErr.message)

    if (newPages.length > 0) {
      newPages.sort((a, b) => a.page_no - b.page_no)
      const { error: insPageErr } = await svc.from('flipbook_pages').insert(newPages)
      if (insPageErr) throw new Error(insPageErr.message)
    }
  } catch (e) {
    await rollback()
    return NextResponse.json({ error: e instanceof Error ? `저장하지 못했어요: ${e.message}` : '저장하지 못했어요' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, slug: newSlug })
}
