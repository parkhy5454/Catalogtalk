'use client'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { SITE_NAME } from '@/lib/site'

// Shared shell for every signed-in page: top bar plus a fixed bottom tab bar.
// Route protection is still done by middleware.ts; this file only handles layout.
const TABS = [
  { href: '/dashboard', label: '홈', icon: '🏠' },
  { href: '/dashboard/folders', label: '폴더', icon: '📁' },
  { href: '/dashboard/referral', label: '친구 추천', icon: '🎁' },
  { href: '/dashboard/profile', label: '내 정보', icon: '👤' },
] as const

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.replace('/')
    router.refresh()
  }

  return (
    <div className="page dash-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <Link href="/dashboard" className="brand" aria-label="카탈로그톡 홈">
            <span className="brand-mark" aria-hidden="true">C</span>
            <span className="brand-name">{SITE_NAME}</span>
            <span className="pill">BETA</span>
          </Link>
          <div className="topbar-actions">
            <button type="button" onClick={handleLogout} className="btn btn-primary" style={{ minHeight: 48 }}>
              로그아웃
            </button>
          </div>
        </div>
      </header>

      {children}

      <nav className="tabbar" aria-label="주요 메뉴">
        <div className="tabbar-inner">
          {TABS.map((tab) => {
            const active = tab.href === '/dashboard' ? pathname === '/dashboard' : pathname.startsWith(tab.href)
            return (
              <Link key={tab.href} href={tab.href} aria-current={active ? 'page' : undefined}>
                <span className="tab-icon" aria-hidden="true">{tab.icon}</span>
                <span>{tab.label}</span>
              </Link>
            )
          })}
        </div>
      </nav>
    </div>
  )
}
