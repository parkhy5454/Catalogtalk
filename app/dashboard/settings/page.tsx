'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { CONTRACT_FEATURE_ON } from '@/lib/contracts/flags'

// Settings tab: account and operator entries, plus sign-out.
export default function SettingsPage() {
  const router = useRouter()
  const supabase = createClient()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [isAdmin, setIsAdmin] = useState(false)
  const [withdrawOpen, setWithdrawOpen] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [withdrawing, setWithdrawing] = useState(false)
  const [withdrawError, setWithdrawError] = useState<string | null>(null)

  useEffect(() => {
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      setEmail(user.email ?? '')
      const { data } = await supabase
        .from('customers')
        .select('name, is_admin')
        .eq('user_id', user.id)
        .maybeSingle()
      setName(data?.name ?? '')
      setIsAdmin(data?.is_admin === true)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.replace('/')
    router.refresh()
  }

  const handleWithdraw = async () => {
    if (confirmText !== '탈퇴' || withdrawing) return
    setWithdrawing(true)
    setWithdrawError(null)
    try {
      const res = await fetch('/api/account/delete', { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? '탈퇴 처리에 실패했어요')
      }
      await supabase.auth.signOut()
      router.replace('/')
      router.refresh()
    } catch (e) {
      setWithdrawError(e instanceof Error ? e.message : '탈퇴 처리에 실패했어요')
      setWithdrawing(false)
    }
  }

  return (
    <main className="container section">
      <section className="panel" aria-labelledby="settings-title">
        <div className="panel-head">
          <h1 className="panel-title" id="settings-title">설정</h1>
        </div>

        <div className="info-box" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <span className="info-label">계정</span>
            <span className="info-value">{name || '이름 미입력'}</span>
            <span className="info-value truncate" style={{ fontWeight: 500, flex: '1 1 160px', minWidth: 0 }}>{email || '-'}</span>
          </div>
        </div>

        <nav className="menu-list" aria-label="설정 메뉴">
          <Link className="menu-item" href="/dashboard/profile">
            <span>👤 내 정보</span>
            <span aria-hidden="true">›</span>
          </Link>
          <Link className="menu-item" href="/dashboard/team">
            <span>👥 팀</span>
            <span aria-hidden="true">›</span>
          </Link>
          {CONTRACT_FEATURE_ON && (
            <Link className="menu-item" href="/dashboard/contracts">
              <span>📝 계약서</span>
              <span aria-hidden="true">›</span>
            </Link>
          )}
          <Link className="menu-item" href="/dashboard/pipeline">
            <span>📋 고객 파이프라인</span>
            <span aria-hidden="true">›</span>
          </Link>
          <Link className="menu-item" href="/dashboard/deals">
            <span>💼 거래 기록</span>
            <span aria-hidden="true">›</span>
          </Link>
          <Link className="menu-item" href="/dashboard/integrations">
            <span>🔌 외부 연동</span>
            <span aria-hidden="true">›</span>
          </Link>
          {isAdmin && (
            <Link className="menu-item" href="/dashboard/admin">
              <span>🛠 관리자 보드</span>
              <span aria-hidden="true">›</span>
            </Link>
          )}
        </nav>

        <button type="button" className="btn btn-danger btn-block" style={{ marginTop: 20 }} onClick={handleLogout}>
          로그아웃
        </button>

        <div style={{ marginTop: 28, borderTop: '1px solid var(--line, #eee)', paddingTop: 16 }}>
          {!withdrawOpen ? (
            <button type="button" className="btn btn-ghost btn-block" onClick={() => setWithdrawOpen(true)}>
              회원 탈퇴
            </button>
          ) : (
            <div className="form-stack">
              <div className="notice notice-error">
                탈퇴하면 모든 카탈로그, 공유 링크, 조회 통계가 삭제되고 되돌릴 수 없어요.
              </div>
              <label className="field">
                <span className="field-label">탈퇴하려면 아래 칸에 &quot;탈퇴&quot;라고 입력해 주세요</span>
                <input
                  className="input"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  disabled={withdrawing}
                  autoComplete="off"
                />
              </label>
              {withdrawError && <div className="notice notice-error" role="alert">{withdrawError}</div>}
              <button
                type="button"
                className="btn btn-danger btn-block"
                disabled={confirmText !== '탈퇴' || withdrawing}
                onClick={handleWithdraw}
              >
                {withdrawing ? '탈퇴 처리 중...' : '탈퇴하고 모든 데이터 삭제'}
              </button>
            </div>
          )}
        </div>
      </section>
    </main>
  )
}
