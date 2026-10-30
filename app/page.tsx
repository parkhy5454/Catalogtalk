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
          <div className="hero-tag">카탈로그로 견적과 주문까지</div>
          <h1 className="hero-title">
            PDF 카탈로그를<br />카톡에서 바로 보고<br />
            <em>견적·주문</em>까지
          </h1>
          <p className="hero-sub">
            고객은 앱 설치 없이 카톡에서 보고 바로 견적을 요청해요.<br />
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
            <div className="icon" aria-hidden="true">🤖</div>
            <h3>상품 자동 등록</h3>
            <p>PDF를 올리면 상품명·가격을 AI가 읽어 한 번에 등록</p>
          </div>
          <div className="feature-card">
            <div className="icon" aria-hidden="true">📊</div>
            <h3>조회수 추적</h3>
            <p>누가 언제 봤는지, 몇 페이지까지 봤는지 실시간 추적</p>
          </div>
          <div className="feature-card">
            <div className="icon" aria-hidden="true">🛒</div>
            <h3>카톡에서 견적·주문</h3>
            <p>고객이 카톡에서 바로 옵션을 고르고 견적을 요청</p>
          </div>
          <div className="feature-card">
            <div className="icon" aria-hidden="true">🎯</div>
            <h3>AI 영업 분석</h3>
            <p>살 가능성이 높은 고객과 후속 메시지 초안을 알려줘요</p>
          </div>
          <div className="feature-card">
            <div className="icon" aria-hidden="true">🔳</div>
            <h3>QR 오프라인 분석</h3>
            <p>전단·매장 QR마다 열어본 수를 따로 확인</p>
          </div>
          <div className="feature-card">
            <div className="icon" aria-hidden="true">👥</div>
            <h3>고객 관리</h3>
            <p>고객 파이프라인, 고객별 맞춤 링크, 자동 재방문 알림</p>
          </div>
        </section>

      </main>
    </div>
  )
}
