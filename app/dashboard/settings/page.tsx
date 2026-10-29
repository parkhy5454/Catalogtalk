'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

// Same operator as app/dashboard/admin (server-side gate there). Used only to show the menu item.
const ADMIN_EMAILS = ['parkhy5454@gmail.com']

const PLAN_LABELS: Record<string, string> = {
  free: '무료 플랜 (기본 3개)',
  starter: 'Starter (기본 20개)',
  pro: 'Pro (무제한)',
  team: 'Team (무제한)',
}

// Settings tab: account and operator entries, plus sign-out.
export default function SettingsPage() {
  const router = useRouter()
  const supabase = createClient()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [plan, setPlan] = useState('free')
  const [bonus, setBonus] = useState(0)

  useEffect(() => {
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      setEmail(user.email ?? '')
      const { data } = await supabase
        .from('customers')
        .select('name, plan, bonus_flipbooks')
        .eq('user_id', user.id)
        .maybeSingle()
      setName(data?.name ?? '')
      setPlan(data?.plan ?? 'free')
      setBonus(data?.bonus_flipbooks ?? 0)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const isAdmin = ADMIN_EMAILS.includes(email)

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.replace('/')
    router.refresh()
  }

  return (
    <main className="container section">
      <section className="panel" aria-labelledby="settings-title">
        <div className="panel-head">
          <h1 className="panel-title" id="settings-title">설정</h1>
        </div>

        <div className="stat stat-dark" style={{ marginBottom: 16 }}>
          <div className="stat-label">요금제</div>
          <div className="stat-value">
            {PLAN_LABELS[plan] ?? PLAN_LABELS.free}
            {bonus > 0 ? ` + 추천 ${bonus}개` : ''}
          </div>
        </div>

        <div className="info-box" style={{ marginBottom: 16 }}>
          <div className="info-label">계정</div>
          <div className="info-value">{name || '이름 미입력'}</div>
          <div className="info-label" style={{ marginTop: 8 }}>이메일</div>
          <div className="info-value truncate" style={{ fontWeight: 500 }}>{email || '-'}</div>
        </div>

        <nav className="menu-list" aria-label="설정 메뉴">
          <Link className="menu-item" href="/dashboard/profile">
            <span>👤 내 정보</span>
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
      </section>
    </main>
  )
}
