// Account deletion (회원 탈퇴). Removes the user's catalogs and their files, then the auth user.
// Database rows follow by ON DELETE CASCADE (customers, folders, flipbooks, pages, view logs).
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { CHAT_FILE_BUCKET } from '@/lib/chat/files'
import { PRIVATE_BUCKET, PRIVATE_PREFIX, PUBLIC_BUCKET, privatePathOf } from '@/lib/flipbook/storage'

export const dynamic = 'force-dynamic'

type Book = { id: string; slug: string; pdf_url: string | null }

async function filesIn(svc: ReturnType<typeof createServiceClient>, bucket: string, folder: string) {
  const { data } = await svc.storage.from(bucket).list(folder, { limit: 1000 })
  return (data ?? []).filter((f) => f.name && f.id !== null).map((f) => `${folder}/${f.name}`)
}

export async function POST() {
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: '로그인이 필요해요' }, { status: 401 })

  const svc = createServiceClient()
  const { data: books, error: listErr } = await svc
    .from('flipbooks')
    .select('id, slug, pdf_url')
    .eq('user_id', user.id)
  if (listErr) return NextResponse.json({ error: '카탈로그 목록을 불러오지 못했어요' }, { status: 500 })

  const rows = (books ?? []) as Book[]
  for (const bucket of [PRIVATE_BUCKET, PUBLIC_BUCKET]) {
    const paths: string[] = []
    for (const b of rows) {
      for (const folder of [b.slug, b.id]) paths.push(...(await filesIn(svc, bucket, folder)))
      if (bucket === PRIVATE_BUCKET && b.pdf_url?.startsWith(PRIVATE_PREFIX)) paths.push(privatePathOf(b.pdf_url))
      // Legacy originals sit at the bucket root under their public URL.
      if (bucket === PUBLIC_BUCKET && b.pdf_url && !b.pdf_url.startsWith(PRIVATE_PREFIX)) {
        const i = b.pdf_url.indexOf(`/${PUBLIC_BUCKET}/`)
        if (i >= 0) paths.push(decodeURIComponent(b.pdf_url.slice(i + PUBLIC_BUCKET.length + 2).split('?')[0]))
      }
    }
    const unique = paths.filter((p, i) => paths.indexOf(p) === i)
    if (unique.length) await svc.storage.from(bucket).remove(unique).catch(() => undefined)
  }

  // Chat photos and PDFs the user sent are removed with the account.
  const { data: chatFiles } = await svc
    .from('chat_messages')
    .select('file_path')
    .eq('sender_id', user.id)
    .not('file_path', 'is', null)
  const chatPaths = (chatFiles ?? []).map((r) => r.file_path as string).filter(Boolean)
  if (chatPaths.length > 0) await svc.storage.from(CHAT_FILE_BUCKET).remove(chatPaths).catch(() => undefined)

  const { error } = await svc.auth.admin.deleteUser(user.id)
  if (error) return NextResponse.json({ error: '탈퇴 처리에 실패했어요. 잠시 후 다시 시도해 주세요.' }, { status: 500 })
  await sb.auth.signOut()
  return NextResponse.json({ ok: true })
}
