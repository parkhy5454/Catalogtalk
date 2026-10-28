'use client'
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { scrollIntoViewOnFocus } from '@/lib/ui'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const router = useRouter()
  const supabase = createClient()

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    setInfo('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      router.push('/dashboard')
      router.refresh()
    }
  }

  const handleMagicLink = async () => {
    if (!email) {
      setError('이메일을 입력하세요')
      return
    }
    setLoading(true)
    setError('')
    setInfo('')
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/dashboard` },
    })
    setLoading(false)
    if (error) setError(error.message)
    else setInfo('📧 이메일로 로그인 링크를 보냈어요! 메일함을 확인해 주세요.')
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-head">
          <div className="auth-icon" aria-hidden="true">📖</div>
          <h1>로그인</h1>
          <p>카탈로그톡 대시보드</p>
        </div>

        {error && <div className="notice notice-error" role="alert">{error}</div>}
        {info && <div className="notice notice-success" role="status">{info}</div>}

        <form onSubmit={handleLogin} className="form-stack" style={{ marginTop: error || info ? 16 : 0 }}>
          <label className="field">
            <span className="field-label">이메일</span>
            <input
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onFocus={scrollIntoViewOnFocus}
              placeholder="이메일 주소"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              required
            />
          </label>
          <label className="field">
            <span className="field-label">비밀번호</span>
            <input
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onFocus={scrollIntoViewOnFocus}
              placeholder="비밀번호"
              type="password"
              autoComplete="current-password"
              required
            />
          </label>
          <button disabled={loading} type="submit" className="btn btn-primary btn-block">
            {loading ? '로그인 중...' : '로그인'}
          </button>
        </form>

        <button
          type="button"
          onClick={handleMagicLink}
          disabled={loading}
          className="btn btn-ghost btn-block"
          style={{ marginTop: 8 }}
        >
          ✉️ 이메일 링크로 로그인
        </button>

        <div className="auth-foot">
          계정이 없나요? <Link href="/signup">회원가입</Link>
        </div>
        <div className="center">
          <Link href="/" className="link-quiet">← 홈으로</Link>
        </div>
      </div>
    </div>
  )
}
