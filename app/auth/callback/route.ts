// Email links (sign-up confirmation, password reset) come back here with a one-time code.
// The code is exchanged for a session, then the user goes to the page in `next`.
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

// Only same-site paths are allowed, so the redirect cannot be used to send users elsewhere.
function safeNext(value: string | null) {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/dashboard'
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const next = safeNext(url.searchParams.get('next'))
  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (error) return NextResponse.redirect(new URL('/login?error=link', url.origin))
  }
  return NextResponse.redirect(new URL(next, url.origin))
}
