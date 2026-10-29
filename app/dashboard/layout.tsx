'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { SITE_NAME } from '@/lib/site'
import InstallBanner from './install-banner'

// App shell for every signed-in page: dark app header on top, five-slot bottom tab bar
// with the upload button in the centre. Route protection is in middleware.ts.
const LEFT_TABS = [
  { href: '/dashboard', label: '홈', icon: '🏠' },
  { href: '/dashboard/folders', label: '폴더', icon: '📁' },
] as const
const RIGHT_TABS = [
  { href: '/dashboard/referral', label: '친구 추천', icon: '🎁' },
  { href: '/dashboard/profile', label: '내 정보', icon: '👤' },
] as const

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()
  const [keyboardOpen, setKeyboardOpen] = useState(false)

  // When the on-screen keyboard opens, the visual viewport shrinks: hide the tab bar so it
  // does not cover the input (same behaviour as native apps).
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const onResize = () => setKeyboardOpen(vv.height < window.innerHeight * 0.75)
    vv.addEventListener('resize', onResize)
    return () => vv.removeEventListener('resize', onResize)
  }, [])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.replace('/')
    router.refresh()
  }

  const isActive = (href: string) => (href === '/dashboard' ? pathname === '/dashboard' : pathname.startsWith(href))

  return (
    <div className="page dash-shell">
      <header className="app-header">
        <Link href="/dashboard" className="brand" aria-label="카탈로그톡 홈" style={{ color: '#fff' }}>
          <span className="brand-mark" aria-hidden="true">C</span>
          <span className="brand-name" style={{ color: '#fff' }}>{SITE_NAME}</span>
        </Link>
        <button type="button" onClick={handleLogout} className="btn app-header-btn">
          로그아웃
        </button>
      </header>

      <div className="container" style={{ paddingTop: 12 }}>
        <InstallBanner />
      </div>
      {children}

      <nav className={`tabbar${keyboardOpen ? ' is-hidden' : ''}`} aria-label="주요 메뉴">
        <div className="tabbar-inner">
          {LEFT_TABS.map((tab) => (
            <Link key={tab.href} href={tab.href} aria-current={isActive(tab.href) ? 'page' : undefined}>
              <span className="tab-icon" aria-hidden="true">{tab.icon}</span>
              <span>{tab.label}</span>
            </Link>
          ))}
          <Link href="/dashboard#create" className="tab-plus-link" aria-label="새 플립북 만들기">
            <span className="tab-plus" aria-hidden="true">+</span>
          </Link>
          {RIGHT_TABS.map((tab) => (
            <Link key={tab.href} href={tab.href} aria-current={isActive(tab.href) ? 'page' : undefined}>
              <span className="tab-icon" aria-hidden="true">{tab.icon}</span>
              <span>{tab.label}</span>
            </Link>
          ))}
        </div>
      </nav>
    </div>
  )
}
