'use server'
// Operator actions for chat reports. Every action re-checks customers.is_admin on the server.
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { CHAT_FILE_BUCKET } from '@/lib/chat/files'

async function assertAdmin() {
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) throw new Error('로그인이 필요해요')
  const { data: me } = await sb.from('customers').select('is_admin').eq('user_id', user.id).maybeSingle()
  if (me?.is_admin !== true) throw new Error('권한이 없어요')
}

export async function setReportStatus(formData: FormData) {
  await assertAdmin()
  const id = String(formData.get('id') ?? '')
  const status = String(formData.get('status') ?? '')
  if (!id || (status !== 'resolved' && status !== 'dismissed')) return
  const svc = createServiceClient()
  await svc.from('chat_reports').update({ status, handled_at: new Date().toISOString() }).eq('id', id)
  revalidatePath('/dashboard/admin')
}

/** Replaces the message text with a notice and removes its file and catalog card. */
export async function removeReportedMessage(formData: FormData) {
  await assertAdmin()
  const reportId = String(formData.get('report_id') ?? '')
  const messageId = String(formData.get('message_id') ?? '')
  if (!reportId || !messageId) return
  const svc = createServiceClient()
  const { data: msg } = await svc.from('chat_messages').select('file_path').eq('id', messageId).maybeSingle()
  if (msg?.file_path) await svc.storage.from(CHAT_FILE_BUCKET).remove([msg.file_path]).catch(() => undefined)
  await svc
    .from('chat_messages')
    .update({
      body: '[운영 정책에 따라 삭제된 메시지]',
      file_path: null,
      file_name: null,
      file_type: null,
      file_size: null,
      catalog_slug: null,
      catalog_title: null,
      catalog_thumb: null,
    })
    .eq('id', messageId)
  await svc.from('chat_reports').update({ status: 'resolved', handled_at: new Date().toISOString() }).eq('id', reportId)
  revalidatePath('/dashboard/admin')
}
