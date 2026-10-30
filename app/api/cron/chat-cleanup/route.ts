// Daily job (Vercel Cron): permanently removes chat messages older than their room's auto-delete timer,
// with their photos and PDFs. Only runs when called with the CRON_SECRET bearer token.
import 'server-only'
import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { CHAT_FILE_BUCKET } from '@/lib/chat/files'

export const dynamic = 'force-dynamic'

const BATCH = 500
const MAX_BATCHES_PER_THREAD = 40

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const svc = createServiceClient()
  const { data: threads, error } = await svc
    .from('chat_threads')
    .select('id, auto_delete_hours')
    .not('auto_delete_hours', 'is', null)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  let deleted = 0
  for (const t of threads ?? []) {
    const cutoff = new Date(Date.now() - (t.auto_delete_hours as number) * 60 * 60 * 1000).toISOString()
    for (let i = 0; i < MAX_BATCHES_PER_THREAD; i++) {
      const { data: old } = await svc
        .from('chat_messages')
        .select('id, file_path')
        .eq('thread_id', t.id)
        .lt('created_at', cutoff)
        .limit(BATCH)
      if (!old || old.length === 0) break

      const paths = old.map((m) => m.file_path).filter((p): p is string => !!p)
      if (paths.length > 0) await svc.storage.from(CHAT_FILE_BUCKET).remove(paths).catch(() => undefined)

      const ids = old.map((m) => m.id)
      const { error: delErr } = await svc.from('chat_messages').delete().in('id', ids)
      if (delErr) return NextResponse.json({ error: delErr.message, deleted }, { status: 500 })
      deleted += ids.length
    }
  }

  return NextResponse.json({ ok: true, deleted })
}
