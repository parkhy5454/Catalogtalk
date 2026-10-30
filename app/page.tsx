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

        <section className="flow" aria-label="카탈로그톡 사용 흐름">
          <div className="flow-step">
            <div className="flow-icon" aria-hidden="true">📄</div>
            <h3>PDF 카탈로그 업로드</h3>
            <p>기존 카탈로그 그대로 사용해요</p>
          </div>
          <div className="flow-arrow" aria-hidden="true">↓</div>
          <div className="flow-step">
            <div className="flow-icon" aria-hidden="true">✨</div>
            <h3>AI 상품 자동 인식</h3>
            <p>상품명·이미지·가격·옵션·설명을 한 번에 정리</p>
          </div>
          <div className="flow-arrow" aria-hidden="true">↓</div>
          <div className="flow-step flow-step--core">
            <div className="flow-icon" aria-hidden="true">📱</div>
            <h3>모바일 디지털 카탈로그</h3>
            <p>카카오톡·문자·이메일·QR로 공유</p>
            <div className="flow-tags">
              <span>상품 상세</span><span>견적 요청</span><span>장바구니</span><span>주문</span>
            </div>
          </div>
          <div className="flow-arrow" aria-hidden="true">↓</div>
          <div className="flow-split">
            <div className="flow-step">
              <div className="flow-icon" aria-hidden="true">📈</div>
              <h3>AI 영업 분석</h3>
              <p>고객 관심도와 구매 가능성</p>
            </div>
            <div className="flow-step">
              <div className="flow-icon" aria-hidden="true">🧾</div>
              <h3>주문·견적 관리</h3>
              <p>견적과 주문 상태를 한 곳에서</p>
            </div>
          </div>
          <div className="flow-arrow" aria-hidden="true">↓</div>
          <div className="flow-step">
            <div className="flow-icon" aria-hidden="true">🔁</div>
            <h3>재방문·고객관리 자동화</h3>
            <p>한 번 본 고객이 다시 찾아오는 구조</p>
          </div>
        </section>

        <section id="features" className="feature-grid" aria-labelledby="features-title">
          <h2 id="features-title" className="sr-only">주요 기능</h2>
          <div className="feature-card">
            <div className="icon" aria-hidden="true">🛒</div>
            <h3>카톡에서 바로 견적·주문</h3>
            <p>상품별 견적 요청, 수량·옵션·납기 입력, 주문서 자동 생성, 이메일 알림</p>
          </div>
          <div className="feature-card">
            <div className="icon" aria-hidden="true">🎯</div>
            <h3>AI 영업 분석</h3>
            <p>카탈로그를 연 고객, 오래 본 상품, 구매 가능성이 높은 고객을 자동 분류하고 후속 메시지 초안까지</p>
          </div>
          <div className="feature-card">
            <div className="icon" aria-hidden="true">🔳</div>
            <h3>QR 카탈로그·오프라인 분석</h3>
            <p>제품별 QR을 만들어 전시회·매장·명함에 넣고, QR별 열람을 확인</p>
          </div>
          <div className="feature-card">
            <div className="icon" aria-hidden="true">✨</div>
            <h3>AI 카탈로그 자동 제작</h3>
            <p>상품명·가격·이미지를 추출하고, 상품 설명 작성과 다국어 번역, 신제품 카탈로그까지</p>
          </div>
          <div className="feature-card">
            <div className="icon" aria-hidden="true">👥</div>
            <h3>고객관리 CRM</h3>
            <p>고객별 상담 이력, 발송 이력, 견적·주문 상태, 재구매 시기 알림</p>
          </div>
          <div className="feature-card">
            <div className="icon" aria-hidden="true">🤝</div>
            <h3>고객별 맞춤 카탈로그</h3>
            <p>거래처별 가격, 고객 전용 상품, 할인·프로모션, 고객별 비공개 링크</p>
          </div>
          <div className="feature-card feature-card--wide">
            <div className="icon" aria-hidden="true">🔁</div>
            <h3>자동 재방문·재구매 마케팅</h3>
            <p>미열람 고객 알림, 견적 미완료 리마인드, 재구매 주기 자동 관리, 캠페인별 성과 분석</p>
          </div>
        </section>

      </main>
    </div>
  )
}
