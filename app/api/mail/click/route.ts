// Mail link: records the click for campaign results, then opens the catalog.
import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { SITE_URL } from '@/lib/site'

export const dynamic = 'force-dynamic'

const KINDS = ['notice', 'reorder', 'unviewed', 'quote_reminder']
const UUID_RE = /^[0-9a-f-]{36}$/i

export async function GET(req: Request) {
  const u = new URL(req.url)
  const t = u.searchParams.get('t') ?? ''
  const k = u.searchParams.get('k') ?? ''
  if (!UUID_RE.test(t) || !KINDS.includes(k)) return NextResponse.redirect(SITE_URL)

  const svc = createServiceClient()
  const { data: lead } = await svc
    .from('flipbook_leads').select('id, flipbook_id').eq('unsubscribe_token', t).maybeSingle()
  if (!lead) return NextResponse.redirect(SITE_URL)

  const { data: book } = await svc.from('flipbooks').select('slug').eq('id', lead.flipbook_id).maybeSingle()
  await svc.from('email_clicks').insert({ flipbook_id: lead.flipbook_id, lead_id: lead.id, kind: k })
  return NextResponse.redirect(book ? `${SITE_URL}/b/${book.slug}` : SITE_URL)
}
