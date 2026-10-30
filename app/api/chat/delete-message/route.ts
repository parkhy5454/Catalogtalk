// "Delete for everyone": only the sender can remove their own message. The text is replaced with a notice
// and any photo, PDF, or catalog card is removed from storage and from the message.
import 'server-only'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { CHAT_FILE_BUCKET } from '@/lib/chat/files'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { message_id?: string } | null
  const messageId = body?.message_id
  if (!messageId) return NextResponse.json({ error: '메시지를 찾지 못했어요' }, { status: 400 })

  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: '로그인이 필요해요' }, { status: 401 })

  // Reading through the user's client proves I can see the message (member of its room).
  const { data: msg } = await sb
    .from('chat_messages')
    .select('id, sender_id, file_path')
    .eq('id', messageId)
    .maybeSingle()
  if (!msg) return NextResponse.json({ error: '메시지를 찾지 못했어요' }, { status: 404 })
  if (msg.sender_id !== user.id) return NextResponse.json({ error: '내가 보낸 메시지만 지울 수 있어요' }, { status: 403 })

  const svc = createServiceClient()
  if (msg.file_path) await svc.storage.from(CHAT_FILE_BUCKET).remove([msg.file_path]).catch(() => undefined)
  const { error } = await svc
    .from('chat_messages')
    .update({
      body: '삭제된 메시지',
      file_path: null,
      file_name: null,
      file_type: null,
      file_size: null,
      catalog_slug: null,
      catalog_title: null,
      catalog_thumb: null,
    })
    .eq('id', messageId)
  if (error) return NextResponse.json({ error: '지우지 못했어요' }, { status: 500 })

  return NextResponse.json({ ok: true })
}
