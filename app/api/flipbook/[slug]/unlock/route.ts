// Viewer password check. On success it sets a one-day cookie for this catalog only.
import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { UNLOCK_SECONDS, cookieName, unlockToken, verifyPassword } from '@/lib/flipbook/password'

export const dynamic = 'force-dynamic'

function decodeSlug(raw: string) {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeSlug(params.slug)
  const body = await req.json().catch(() => null)
  const password = typeof body?.password === 'string' ? body.password : ''
  if (!password || password.length > 100) {
    return NextResponse.json({ error: '비밀번호를 입력해 주세요' }, { status: 400 })
  }

  const { data } = await createServiceClient()
    .from('flipbooks')
    .select('password_hash, is_public')
    .eq('slug', slug)
    .maybeSingle()
  if (!data || !data.is_public) return NextResponse.json({ error: '플립북을 찾을 수 없어요' }, { status: 404 })
  if (!data.password_hash) return NextResponse.json({ ok: true })

  if (!verifyPassword(password, data.password_hash)) {
    return NextResponse.json({ error: '비밀번호가 맞지 않아요' }, { status: 403 })
  }
  const res = NextResponse.json({ ok: true })
  res.cookies.set(cookieName(slug), unlockToken(slug, data.password_hash), {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: UNLOCK_SECONDS,
  })
  return res
}
