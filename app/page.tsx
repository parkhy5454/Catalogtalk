import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export default async function Home() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  return (
    <div className="landing">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="landing-logo">CATALOGTALK</div>
          <div className="topbar-actions">
            {user ? (
              <>
                <span className="topbar-email truncate">{user.email}</span>
                <Link href="/dashboard" className="btn btn-white">대시보드</Link>
              </>
            ) : (
              <>
                <Link href="/login" className="btn btn-dark">로그인</Link>
                <Link href="/signup" className="btn btn-white">시작하기</Link>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="container">
        <section className="hero">
          <div className="hero-tag">디지털 북으로 바꿔주는 플립북</div>
          <h1 className="hero-title">
            PDF 카탈로그를<br />카톡에서 바로 보는<br />
            <em>플립북 링크</em>로
          </h1>
          <p className="hero-sub">
            고객은 앱 설치 없이 카톡에서 바로 봅니다.<br />
            누가 몇 초 봤는지, 어디서 이탈했는지 실시간으로 알 수 있어요.
          </p>
          <div className="hero-actions">
            {user ? (
              <Link href="/dashboard" className="btn btn-coral">대시보드로 이동 →</Link>
            ) : (
              <Link href="/signup" className="btn btn-coral">무료로 시작하기 - 0원</Link>
            )}
            <a href="#features" className="btn btn-dark">데모 보기</a>
          </div>
        </section>

        <section id="features" className="feature-grid" aria-labelledby="features-title">
          <h2 id="features-title" className="sr-only">주요 기능</h2>
          <div className="feature-card">
            <div className="icon" aria-hidden="true">⚡️</div>
            <h3>3초 변환</h3>
            <p>PDF 업로드하면 3초 만에 카톡 공유용 링크 생성</p>
          </div>
          <div className="feature-card">
            <div className="icon" aria-hidden="true">📊</div>
            <h3>조회수 추적</h3>
            <p>누가 언제 봤는지, 몇 페이지까지 봤는지 실시간 추적</p>
          </div>
          <div className="feature-card">
            <div className="icon" aria-hidden="true">💬</div>
            <h3>카톡 최적화</h3>
            <p>오픈그래프 썸네일, 카톡에서 예쁘게 보이는 링크</p>
          </div>
        </section>

        <section className="cost-box" aria-labelledby="cost-title">
          <h2 id="cost-title">💰 운영 비용 (프로덕션)</h2>
          Vercel Hobby $0 + Supabase Free $0 = 월 0원 (고객 50곳까지)<br />
          고객 200곳 이상: Supabase Pro $25 또는 Cloudflare R2 + Neon으로 이전 (월 $7~$20)<br />
          <br />
          • 무료 플랜: 0.5GB DB, 1GB 스토리지, 50GB 대역폭<br />
          • RLS 보안 활성화, 고객별 데이터 격리, 조회 기록 포함
        </section>
      </main>
    </div>
  )
}
