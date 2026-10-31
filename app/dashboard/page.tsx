'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'

const PLAN_SHORT: Record<string, string> = {
  free: '무료',
  starter: 'Starter',
  pro: 'Pro',
  team: 'Team',
}

// Home: explains what the app is, shows a quick summary, and points to the two main places.
export default function DashboardPage() {
  const supabase = createClient()
  const [count, setCount] = useState<number | null>(null)
  const [views, setViews] = useState(0)
  const [plan, setPlan] = useState('free')
  const [bonus, setBonus] = useState(0)

  useEffect(() => {
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const [books, cust] = await Promise.all([
        supabase.from('flipbooks').select('views').eq('user_id', user.id),
        supabase.from('customers').select('plan, bonus_flipbooks').eq('user_id', user.id).maybeSingle(),
      ])
      setPlan(cust.data?.plan ?? 'free')
      setBonus(cust.data?.bonus_flipbooks ?? 0)
      const data = books.data
      const rows = (data as { views: number | null }[] | null) ?? []
      setCount(rows.length)
      setViews(rows.reduce((sum, r) => sum + (r.views || 0), 0))
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <main className="container home-fit">
      <section className="intro-card" aria-label="카탈로그톡 소개">
        <div className="intro-badge">CATALOGTALK</div>
        <h1 className="intro-title">PDF를 디지털 북으로<br />바꿔주는 <em>플립북</em></h1>
        <p className="intro-sub">책처럼 넘겨 보는 카탈로그를 만들고, 견적·주문까지 받으세요.</p>
        <ol className="intro-steps">
          <li><span className="intro-num">1</span><span>PDF 또는 Word 파일을 올리면 상품을 자동으로 읽어요</span></li>
          <li><span className="intro-num">2</span><span>플립북 링크와 모바일 카탈로그가 바로 생겨요</span></li>
          <li><span className="intro-num">3</span><span>카톡·문자·QR로 공유해요</span></li>
          <li><span className="intro-num">4</span><span>고객이 카탈로그에서 견적·주문을 요청해요</span></li>
          <li><span className="intro-num">5</span><span>AI 영업 분석과 재방문 알림으로 다시 찾아오게 해요</span></li>
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
        <div className="stat">
          <div className="stat-label">요금제</div>
          <div className="stat-value">{PLAN_SHORT[plan] ?? PLAN_SHORT.free}</div>
          {bonus > 0 && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>추천 +{bonus}</div>}
        </div>
      </div>

      <Link href="/dashboard/folders" className="btn btn-ghost btn-block" style={{ marginTop: 4 }}>
        My Book에서 플립북 모아보기 →
      </Link>
    </main>
  )
}
