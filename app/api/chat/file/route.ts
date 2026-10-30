// Open a chat file. Only members of the room can read the message (RLS), then a short-lived signed link is issued.
import 'server-only'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { CHAT_FILE_BUCKET } from '@/lib/chat/files'

export const dynamic = 'force-dynamic'

const SIGNED_SECONDS = 60 * 10

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: '파일을 찾지 못했어요' }, { status: 400 })

  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: '로그인이 필요해요' }, { status: 401 })

  const { data: msg } = await sb.from('chat_messages').select('file_path').eq('id', id).maybeSingle()
  if (!msg?.file_path) return NextResponse.json({ error: '파일을 찾지 못했어요' }, { status: 404 })

  const svc = createServiceClient()
  const { data, error } = await svc.storage.from(CHAT_FILE_BUCKET).createSignedUrl(msg.file_path, SIGNED_SECONDS)
  if (error || !data) return NextResponse.json({ error: '파일을 열지 못했어요' }, { status: 500 })

  return NextResponse.redirect(data.signedUrl, { status: 302, headers: { 'Cache-Control': 'no-store' } })
}
