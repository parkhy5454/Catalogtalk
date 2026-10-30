'use client'
import PasswordInput from '@/components/password-input'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { scrollIntoViewOnFocus } from '@/lib/ui'
import { formatPhone } from '@/lib/phone'

// Referral codes are 8 uppercase hex characters (see schema.sql). Anything else is ignored.
const REF_PATTERN = /^[A-Z0-9]{4,16}$/

export default function SignupPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [ref, setRef] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const router = useRouter()
  const supabase = createClient()

  useEffect(() => {
    // Friend referral: /signup?ref=CODE. Read on the client to keep the page statically renderable.
    const code = new URLSearchParams(window.location.search).get('ref')?.trim().toUpperCase() ?? ''
    if (REF_PATTERN.test(code)) setRef(code)
    // supabase is stable for the lifetime of the page
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    setInfo('')
    // The customers row is created by a database trigger (see schema.sql), which also
    // reads these metadata keys and applies the referral bonus. No client-side insert.
    // Record the sign-up address hash first, so the referral check can see it later.
    try {
      await fetch('/api/signup-track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      })
    } catch {
      // Tracking is best effort; sign-up must still work.
    }
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          name: name.trim(),
          phone: phone.trim(),
          ...(ref ? { ref } : {}),
        },
      },
    })
    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }
    if (data.session) {
      router.push('/dashboard')
      router.refresh()
    } else {
      // Email confirmation is enabled in Supabase: there is no session yet.
      setLoading(false)
      setInfo('📧 가입 확인 메일을 보냈어요. 메일의 링크를 누른 뒤 로그인해 주세요.')
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-head">
          <div className="hero-tag" style={{ background: '#111', color: '#fff', fontSize: 11, padding: '6px 12px', marginBottom: 12 }}>
            <span style={{ color: '#4ade80' }}>●</span> 지금 가입하면 첫 달 무료
          </div>
          <h1>카탈로그를<br />카톡처럼 보내세요</h1>
          <p>PDF나 Word 문서를 올리면 3초 만에 플립북 링크 완성</p>
        </div>

        {ref && <div className="notice notice-info" role="status">친구 추천으로 가입하면 추가 플립북 슬롯을 받아요</div>}
        {error && <div className="notice notice-error" role="alert">{error}</div>}
        {info && <div className="notice notice-success" role="status">{info}</div>}

        {!info && (
          <form onSubmit={handleSignup} className="form-stack" style={{ marginTop: error || ref ? 16 : 0 }}>
            <label className="field">
              <span className="sr-only">이름</span>
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onFocus={scrollIntoViewOnFocus}
                placeholder="이름 (선택)"
                autoComplete="name"
                maxLength={50}
              />
            </label>
            <label className="field">
              <span className="sr-only">휴대폰 번호</span>
              <input
                className="input"
                value={phone}
                onChange={(e) => setPhone(formatPhone(e.target.value))}
                onFocus={scrollIntoViewOnFocus}
                placeholder="휴대폰 번호 (선택)"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                maxLength={20}
              />
            </label>
            <label className="field">
              <span className="sr-only">이메일</span>
              <input
                className="input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onFocus={scrollIntoViewOnFocus}
                placeholder="이메일"
                type="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="none"
                required
              />
            </label>
            <label className="field">
              <span className="sr-only">비밀번호</span>
              <PasswordInput
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onFocus={scrollIntoViewOnFocus}
                placeholder="비밀번호 (6자 이상)"
                autoComplete="new-password"
                required
                minLength={6}
              />
            </label>
            <button disabled={loading} type="submit" className="btn btn-primary btn-block" style={{ marginTop: 4 }}>
              {loading ? '가입 중...' : '무료로 시작하기'}
            </button>
          </form>
        )}

        <div className="auth-foot">
          이미 계정이 있나요? <Link href="/login">로그인</Link>
        </div>
        <div style={{ textAlign: 'center', marginTop: 16, fontSize: 12, color: 'var(--muted)' }}>
<Link href="/privacy" style={{ textDecoration: 'underline', color: 'inherit' }}>개인정보 처리방침</Link>
        </div>
      </div>
    </div>
  )
}
