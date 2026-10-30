// Returns a short-lived link to one catalog page image, for the owner's browser to cut product photos from.
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { resolvePageUrls } from '@/lib/flipbook/sign'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: '로그인이 필요해요' }, { status: 401 })

  const u = new URL(req.url)
  const flipbookId = u.searchParams.get('flipbook_id') ?? ''
  const pageNo = Number(u.searchParams.get('page_no'))
  if (!flipbookId || !Number.isInteger(pageNo) || pageNo < 1) {
    return NextResponse.json({ error: '요청을 확인해 주세요' }, { status: 400 })
  }

  // The session client applies the owner check; only then is the page image read with the service client.
  const { data: book } = await supabase.from('flipbooks').select('id').eq('id', flipbookId).maybeSingle()
  if (!book) return NextResponse.json({ error: '자료를 찾을 수 없어요' }, { status: 404 })

  const svc = createServiceClient()
  const { data: row } = await svc
    .from('flipbook_pages').select('image_url').eq('flipbook_id', flipbookId).eq('page_no', pageNo).maybeSingle()
  if (!row) return NextResponse.json({ error: '해당 쪽이 없어요' }, { status: 404 })

  const [url] = await resolvePageUrls([row.image_url])
  return NextResponse.json({ url })
}
