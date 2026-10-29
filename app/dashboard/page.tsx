'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'

// Home: explains what the app is, shows a quick summary, and points to the two main places.
export default function DashboardPage() {
  const supabase = createClient()
  const [count, setCount] = useState<number | null>(null)
  const [views, setViews] = useState(0)

  useEffect(() => {
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const { data } = await supabase.from('flipbooks').select('views').eq('user_id', user.id)
      const rows = (data as { views: number | null }[] | null) ?? []
      setCount(rows.length)
      setViews(rows.reduce((sum, r) => sum + (r.views || 0), 0))
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <main className="container section">
      <section className="intro-card" aria-label="카탈로그톡 소개">
        <div className="intro-badge">CATALOGTALK</div>
        <h1 className="intro-title">PDF를 디지털 북으로<br />바꿔주는 <em>플립북</em></h1>
        <p className="intro-sub">책처럼 넘겨 보는 카탈로그를 만들고, 카톡으로 바로 보내세요.</p>
        <ol className="intro-steps">
          <li><span className="intro-num">1</span><span>PDF 또는 Word 파일을 올려요</span></li>
          <li><span className="intro-num">2</span><span>플립북 링크가 바로 생겨요</span></li>
          <li><span className="intro-num">3</span><span>카톡·문자로 보내면 고객이 앱 설치 없이 봐요</span></li>
        </ol>
        <Link href="/dashboard/new" className="btn intro-cta">새 플립북 만들기 →</Link>
      </section>

      <div className="stats" aria-label="요약">
        <div className="stat">
          <div className="stat-label">내 플립북</div>
          <div className="stat-value">{count === null ? '-' : `${count}개`}</div>
        </div>
        <div className="stat">
          <div className="stat-label">총 조회수</div>
          <div className="stat-value">{views.toLocaleString()}회</div>
        </div>
      </div>

      <Link href="/dashboard/folders" className="btn btn-ghost btn-block" style={{ marginTop: 4 }}>
        My Book에서 플립북 모아보기 →
      </Link>
    </main>
  )
}
