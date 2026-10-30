// Saves a business registration number for the signed-in member and marks them as a business member.
// Writes with the service role because customers' column grants block users from changing these fields.
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { normalizeBusinessNumber } from '@/lib/business/number'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: '로그인이 필요해요' }, { status: 401 })

  const body = await req.json().catch(() => null)
  const number = normalizeBusinessNumber(typeof body?.number === 'string' ? body.number : '')
  if (!number) return NextResponse.json({ error: '사업자등록번호 10자리를 정확히 입력해 주세요' }, { status: 400 })

  const { error } = await createServiceClient()
    .from('customers')
    .update({ is_business: true, business_number: number })
    .eq('user_id', user.id)
  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: '이미 다른 계정에 등록된 사업자등록번호예요' }, { status: 409 })
    }
    return NextResponse.json({ error: '저장하지 못했어요. 잠시 후 다시 시도해 주세요' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
