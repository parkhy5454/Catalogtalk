// One-click 수신거부 from a notice email. Removes marketing consent for that lead only.
import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function page(message: string) {
  return new Response(
    `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>수신거부</title></head>` +
      `<body style="font-family:system-ui,sans-serif;padding:32px;line-height:1.6"><p>${message}</p></body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
  )
}

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get('t') ?? ''
  if (!UUID.test(token)) return page('잘못된 주소예요.')
  const { data, error } = await createServiceClient()
    .from('flipbook_leads')
    .update({ marketing_consent: false })
    .eq('unsubscribe_token', token)
    .select('id')
  if (error) return page('처리하지 못했어요. 잠시 후 다시 해 주세요.')
  if (!data || data.length === 0) return page('이미 처리됐거나 유효하지 않은 주소예요.')
  return page('수신을 거부했어요. 더 이상 이 자료의 소식 메일을 받지 않아요.')
}
