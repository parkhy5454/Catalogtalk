'use client'
// Password reset, step 1: send the reset link to the registered email.
import { useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'

export default function ForgotPasswordPage() {
  const supabase = createClient()
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/auth/callback?next=/reset`,
    })
    setLoading(false)
    if (error) setError('메일을 보내지 못했어요. 잠시 후 다시 시도해 주세요.')
    else setSent(true)
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-head">
          <h1>비밀번호 찾기</h1>
          <p>가입한 이메일로 비밀번호 재설정 링크를 보내 드려요</p>
        </div>

        {error && <div className="notice notice-error" role="alert">{error}</div>}
        {sent ? (
          <div className="notice notice-success" role="status">
            📧 메일을 보냈어요. 메일함의 링크를 눌러 새 비밀번호를 설정해 주세요. 메일이 안 보이면 스팸함도 확인해 주세요.
          </div>
        ) : (
          <form onSubmit={submit} className="form-stack" style={{ marginTop: error ? 16 : 0 }}>
            <label className="field">
              <span className="sr-only">이메일</span>
              <input
                className="input"
                type="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="none"
                placeholder="가입한 이메일"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
            <button type="submit" disabled={loading} className="btn btn-primary btn-block">
              {loading ? '보내는 중...' : '재설정 링크 받기'}
            </button>
          </form>
        )}

        <div className="auth-foot">
          <Link href="/login">로그인으로 돌아가기</Link>
        </div>
      </div>
    </div>
  )
}
