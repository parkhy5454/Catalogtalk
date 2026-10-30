'use client'
// Password reset, step 2: the reset link has signed the user in for this page only; set a new password here.
import PasswordInput from '@/components/password-input'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export default function ResetPasswordPage() {
  const router = useRouter()
  const supabase = createClient()
  const [ready, setReady] = useState<boolean | null>(null)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      setReady(!!user)
    })()
    // supabase is stable for the lifetime of the page
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (password.length < 6) return setError('비밀번호는 6자 이상이어야 해요')
    if (password !== confirm) return setError('비밀번호가 서로 달라요')
    setLoading(true)
    setError('')
    const { error } = await supabase.auth.updateUser({ password })
    setLoading(false)
    if (error) return setError('비밀번호를 바꾸지 못했어요. 링크를 다시 요청해 주세요.')
    router.replace('/dashboard')
    router.refresh()
  }

  if (ready === null) {
    return <div className="auth-wrap"><div className="skeleton" style={{ height: 200 }} aria-hidden="true" /></div>
  }

  if (!ready) {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <div className="auth-head"><h1>링크가 만료됐어요</h1><p>비밀번호 재설정 링크는 한 번만 쓸 수 있고 시간이 지나면 만료돼요.</p></div>
          <Link href="/forgot" className="btn btn-primary btn-block">다시 요청하기</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-head">
          <h1>새 비밀번호 설정</h1>
          <p>새로 사용할 비밀번호를 입력해 주세요</p>
        </div>
        {error && <div className="notice notice-error" role="alert">{error}</div>}
        <form onSubmit={save} className="form-stack" style={{ marginTop: error ? 16 : 0 }}>
          <label className="field">
            <span className="sr-only">새 비밀번호</span>
            <PasswordInput
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="새 비밀번호 (6자 이상)"
              autoComplete="new-password"
              minLength={6}
              required
            />
          </label>
          <label className="field">
            <span className="sr-only">새 비밀번호 확인</span>
            <PasswordInput
              className="input"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="새 비밀번호 확인"
              autoComplete="new-password"
              minLength={6}
              required
            />
          </label>
          <button type="submit" disabled={loading} className="btn btn-primary btn-block">
            {loading ? '저장 중...' : '비밀번호 바꾸기'}
          </button>
        </form>
      </div>
    </div>
  )
}
