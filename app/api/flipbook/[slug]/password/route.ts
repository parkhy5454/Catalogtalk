// Owner sets or removes a catalog's viewer password. Runs with the owner's session, so RLS
// limits it to their own catalogs.
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { hashPassword } from '@/lib/flipbook/password'

export const dynamic = 'force-dynamic'

function decodeSlug(raw: string) {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const slug = decodeSlug((await params).slug)
  const body = await req.json().catch(() => null)
  const password: string | null = body?.password ?? null
  if (password !== null && (typeof password !== 'string' || password.trim().length < 4 || password.length > 30)) {
    return NextResponse.json({ error: '비밀번호는 4~30자로 입력해 주세요' }, { status: 400 })
  }

  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: '로그인이 필요해요' }, { status: 401 })

  const { data: row } = await sb.from('flipbooks').select('id').eq('slug', slug).maybeSingle()
  if (!row) return NextResponse.json({ error: '플립북을 찾을 수 없어요' }, { status: 404 })

  const { error } = await sb
    .from('flipbooks')
    .update({ password_hash: password === null ? null : hashPassword(password) })
    .eq('id', row.id)
  if (error) return NextResponse.json({ error: '비밀번호를 바꾸지 못했어요' }, { status: 500 })
  return NextResponse.json({ ok: true })
}
