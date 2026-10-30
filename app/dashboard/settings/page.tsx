'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

// Settings tab: account and operator entries, plus sign-out.
export default function SettingsPage() {
  const router = useRouter()
  const supabase = createClient()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [isAdmin, setIsAdmin] = useState(false)

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

  return (
    <main className="container section">
      <section className="panel" aria-labelledby="settings-title">
        <div className="panel-head">
          <h1 className="panel-title" id="settings-title">설정</h1>
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
