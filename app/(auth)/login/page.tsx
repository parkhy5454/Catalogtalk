'use client'
import PasswordInput from '@/components/password-input'
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
  const [needsConfirm, setNeedsConfirm] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    setInfo('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      const msg = error.message.toLowerCase()
      setNeedsConfirm(msg.includes('not confirmed'))
      setError(
        msg.includes('invalid login credentials')
          ? '이메일 또는 비밀번호가 맞지 않아요.'
          : msg.includes('not confirmed')
            ? '이메일 인증이 아직 안 됐어요. 메일의 인증 링크를 눌러 주세요.'
            : error.message
      )
      setLoading(false)
    } else {
      router.push('/dashboard')
      router.refresh()
    }
  }

  const resendConfirm = async () => {
    if (!email) {
      setError('이메일을 입력해 주세요')
      return
    }
    setLoading(true)
    setError('')
    const { error } = await supabase.auth.resend({
      type: 'signup',
      email: email.trim(),
      options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=/dashboard` },
    })
    setLoading(false)
    if (error) setError('인증 메일을 다시 보내지 못했어요. 잠시 후 다시 시도해 주세요.')
    else setInfo('📧 인증 메일을 다시 보냈어요. 메일함을 확인해 주세요.')
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
            <PasswordInput
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onFocus={scrollIntoViewOnFocus}
              placeholder="비밀번호"
              autoComplete="current-password"
              required
            />
          </label>
          <button disabled={loading} type="submit" className="btn btn-primary btn-block">
            {loading ? '로그인 중...' : '로그인'}
          </button>
        </form>

        {needsConfirm && (
          <button type="button" onClick={resendConfirm} disabled={loading} className="btn btn-ghost btn-block" style={{ marginTop: 8 }}>
            인증 메일 다시 보내기
          </button>
        )}

        <div style={{ textAlign: 'center', marginTop: 12, fontSize: 13 }}>
          <Link href="/forgot" style={{ color: 'inherit', textDecoration: 'underline' }}>비밀번호를 잊으셨나요?</Link>
        </div>

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
