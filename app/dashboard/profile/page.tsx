'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { scrollIntoViewOnFocus } from '@/lib/ui'

export default function ProfilePage() {
  const [email, setEmail] = useState('')
  const [createdAt, setCreatedAt] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const router = useRouter()
  const supabase = createClient()

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? '')
      setCreatedAt(data.user?.created_at ?? '')
    })
    // supabase is stable for the lifetime of the page
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const updatePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (newPassword.length < 6) {
      setMsg({ ok: false, text: '비밀번호는 6자 이상이어야 해요' })
      return
    }
    setSaving(true)
    const { error } = await supabase.auth.updateUser({ password: newPassword })
    setSaving(false)
    if (error) setMsg({ ok: false, text: '오류: ' + error.message })
    else {
      setMsg({ ok: true, text: '✅ 비밀번호가 변경되었어요!' })
      setNewPassword('')
    }
  }

  return (
    <div className="page">
      <main className="container section">
        <div className="panel profile-card">
          <h1 className="panel-title" style={{ marginBottom: 20 }}>내 정보</h1>

          <div className="info-box">
            <div className="info-label">이메일</div>
            <div className="info-value">{email || '-'}</div>
            <div className="info-label" style={{ marginTop: 10 }}>가입일</div>
            <div className="info-value" style={{ fontWeight: 500 }}>
              {createdAt ? new Date(createdAt).toLocaleDateString('ko-KR') : '-'}
            </div>
          </div>

          <form onSubmit={updatePassword} className="form-stack">
            <label className="field">
              <span className="field-label">새 비밀번호</span>
              <input
                className="input"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                onFocus={scrollIntoViewOnFocus}
                placeholder="6자 이상 입력"
                autoComplete="new-password"
                minLength={6}
              />
            </label>
            <button type="submit" disabled={saving} className="btn btn-primary btn-block">
              {saving ? '변경 중...' : '비밀번호 변경'}
            </button>
          </form>

          {msg && (
            <div className={`notice ${msg.ok ? 'notice-success' : 'notice-error'}`} role="status" style={{ marginTop: 16 }}>
              {msg.text}
            </div>
          )}

          <div className="btn-row" style={{ marginTop: 20 }}>
            <Link href="/dashboard" className="btn btn-ghost">대시보드</Link>
            <button
              type="button"
              className="btn btn-primary"
              onClick={async () => {
                await supabase.auth.signOut()
                router.replace('/login')
                router.refresh()
              }}
            >
              로그아웃
            </button>
          </div>
        </div>
      </main>
    </div>
  )
}
