// Viewer password check. On success it sets a one-day cookie for this catalog only.
import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { UNLOCK_SECONDS, cookieName, unlockToken, verifyPassword } from '@/lib/flipbook/password'
import { attemptKey, clearFailures, lockedUntil, recordFailure } from '@/lib/flipbook/attempts'

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

  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown'
  const key = attemptKey(slug, ip)
  const until = await lockedUntil(key)
  if (until) {
    const mins = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000))
    return NextResponse.json({ error: `비밀번호를 여러 번 틀렸어요. ${mins}분 뒤에 다시 시도해 주세요` }, { status: 429 })
  }

  if (!verifyPassword(password, data.password_hash)) {
    await recordFailure(key)
    return NextResponse.json({ error: '비밀번호가 맞지 않아요' }, { status: 403 })
  }
  await clearFailures(key)
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
