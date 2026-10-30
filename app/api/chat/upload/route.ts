// Send a photo or PDF in a chat room. The file goes to the private "chat-files" bucket and a message row is added.
import 'server-only'
import { randomUUID } from 'crypto'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { CHAT_FILE_BUCKET } from '@/lib/chat/files'

export const dynamic = 'force-dynamic'

const RULES: Record<string, { ext: string; max: number }> = {
  'image/jpeg': { ext: 'jpg', max: 10 * 1024 * 1024 },
  'image/png': { ext: 'png', max: 10 * 1024 * 1024 },
  'image/webp': { ext: 'webp', max: 10 * 1024 * 1024 },
  'application/pdf': { ext: 'pdf', max: 50 * 1024 * 1024 },
}

export async function POST(req: Request) {
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: '로그인이 필요해요' }, { status: 401 })

  const form = await req.formData().catch(() => null)
  const file = form?.get('file')
  const threadId = String(form?.get('thread_id') ?? '')
  if (!(file instanceof File) || !threadId) {
    return NextResponse.json({ error: '파일을 골라 주세요' }, { status: 400 })
  }

  const rule = RULES[file.type]
  if (!rule) return NextResponse.json({ error: '사진(JPG, PNG, WEBP)이나 PDF만 보낼 수 있어요' }, { status: 400 })
  if (file.size === 0) return NextResponse.json({ error: '빈 파일은 보낼 수 없어요' }, { status: 400 })
  if (file.size > rule.max) {
    const limit = file.type === 'application/pdf' ? '50MB' : '10MB'
    return NextResponse.json({ error: `${limit}까지 보낼 수 있어요` }, { status: 400 })
  }

  // get_chat_thread returns a row only for members of the room.
  const { data: info } = await sb.rpc('get_chat_thread', { p_id: threadId })
  const thread = Array.isArray(info) ? info[0] : null
  if (!thread) return NextResponse.json({ error: '대화를 찾을 수 없어요' }, { status: 404 })

  const svc = createServiceClient()

  if (!thread.is_group && thread.partner_id) {
    const { data: blocked } = await svc
      .from('chat_blocks')
      .select('blocker_id')
      .or(
        `and(blocker_id.eq.${user.id},blocked_id.eq.${thread.partner_id}),and(blocker_id.eq.${thread.partner_id},blocked_id.eq.${user.id})`
      )
      .limit(1)
    if (blocked && blocked.length > 0) {
      return NextResponse.json({ error: '차단된 대화라 보낼 수 없어요' }, { status: 403 })
    }
  }

  const path = `${threadId}/${randomUUID()}.${rule.ext}`
  const { error: upErr } = await svc.storage
    .from(CHAT_FILE_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false })
  if (upErr) return NextResponse.json({ error: '파일을 올리지 못했어요' }, { status: 500 })

  const { data: row, error: insErr } = await svc
    .from('chat_messages')
    .insert({
      thread_id: threadId,
      sender_id: user.id,
      body: '',
      file_path: path,
      file_name: file.name.slice(0, 120),
      file_type: file.type,
      file_size: file.size,
    })
    .select('id, sender_id, body, catalog_title, catalog_slug, catalog_thumb, created_at, file_path, file_name, file_type, file_size')
    .single()
  if (insErr || !row) {
    await svc.storage.from(CHAT_FILE_BUCKET).remove([path]).catch(() => undefined)
    return NextResponse.json({ error: '파일을 보내지 못했어요' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, message: row })
}
