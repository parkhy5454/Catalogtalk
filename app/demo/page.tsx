// Public demo page: explains what the app does, step by step, without sign-in or sample data.
import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: '데모 - 기능 둘러보기',
  description: 'PDF 카탈로그를 올리면 어떻게 카톡 플립북, 견적·주문, 영업 분석까지 이어지는지 단계별로 보여드려요.',
  robots: { index: true, follow: true },
}

const STEPS = [
  {
    no: '1',
    title: 'PDF 올리기',
    who: '영업 담당자',
    what: 'PDF 또는 Word 카탈로그를 올리면 쪽마다 이미지로 바꿔 플립북을 만들어요.',
    result: '기존 카탈로그를 그대로 쓸 수 있어요.',
  },
  {
    no: '2',
    title: 'AI가 상품 자동 인식',
    who: '영업 담당자',
    what: '쪽마다 상품명, 가격, 단위, 옵션, 설명을 읽어 목록으로 보여줘요. 틀린 부분은 고치고 저장하면 돼요.',
    result: '상품 등록을 손으로 하나씩 입력하지 않아도 돼요.',
  },
  {
    no: '3',
    title: '카톡·문자·QR로 공유',
    who: '영업 담당자',
    what: '플립북 링크를 카톡이나 문자로 보내고, 전시회나 매장에는 QR을 붙여요.',
    result: '고객은 앱을 설치하지 않고 바로 봐요.',
  },
  {
    no: '4',
    title: '고객이 보고 견적·주문 요청',
    who: '고객',
    what: '상품 상세를 보고 수량, 옵션, 납기일을 골라 견적을 요청하거나 주문을 보내요. 장바구니에 담아 한 번에 보낼 수도 있어요.',
    result: '담당자에게 이메일로 바로 알려 주고, 주문서를 자동으로 만들어요.',
  },
  {
    no: '5',
    title: '영업 분석과 재방문 관리',
    who: '영업 담당자',
    what: '누가 열어봤는지, 어떤 상품을 오래 봤는지 보여주고, 구매 가능성이 높은 고객을 골라줘요. 미열람 고객에게 알림을 보내고 재구매 시기도 관리해요.',
    result: '다음에 연락할 고객이 분명해져요.',
  },
]

const FEATURES = [
  {
    icon: '🛒',
    title: '카톡에서 바로 견적·주문',
    desc: '상품별 견적 요청 버튼, 수량·옵션·납기일 입력, 주문서 자동 생성, 담당자 이메일 알림, 주문서 인쇄',
  },
  {
    icon: '🎯',
    title: 'AI 영업 분석',
    desc: '카탈로그를 연 고객, 상품별 관심도, 구매 가능성이 높은 고객 자동 분류, 후속 연락 문구 초안',
  },
  {
    icon: '🔳',
    title: 'QR 카탈로그·오프라인 분석',
    desc: '상품별 QR을 만들어 전시회·매장·명함에 넣고, QR로 들어온 열람 수를 따로 확인',
  },
  {
    icon: '✨',
    title: 'AI 카탈로그 자동 제작',
    desc: '상품명·가격·사진 추출, 상품 설명 작성, 다국어 번역, 골라 담은 상품으로 신제품 카탈로그 만들기',
  },
  {
    icon: '👥',
    title: '고객관리 CRM',
    desc: '고객 단계별 파이프라인, 상담 메모, 카탈로그 발송 이력, 견적·주문 상태, 재구매 시기 알림',
  },
  {
    icon: '🤝',
    title: '고객별 맞춤 카탈로그',
    desc: '거래처마다 다른 가격, 고객 전용 상품, 할인·프로모션, 고객만 볼 수 있는 비공개 링크',
  },
  {
    icon: '🔁',
    title: '자동 재방문·재구매 마케팅',
    desc: '미열람 고객 알림, 견적 미완료 리마인드, 재구매 주기 관리, 캠페인별 열람·반응 성과',
  },
]

export default function DemoPage() {
  return (
    <div className="landing">
      <header className="topbar">
        <div className="topbar-inner">
          <Link href="/" className="landing-logo" style={{ textDecoration: 'none', color: 'inherit' }}>CATALOGTALK</Link>
          <div className="topbar-actions">
            <Link href="/login" className="btn btn-dark">로그인</Link>
            <Link href="/signup" className="btn btn-white">시작하기</Link>
          </div>
        </div>
      </header>

      <main className="container">
        <section className="hero" style={{ paddingBottom: 8 }}>
          <div className="hero-tag">데모 · 기능 둘러보기</div>
          <h1 className="hero-title">
            PDF 한 장이<br />
            <em>견적·주문</em>까지 이어지는 과정
          </h1>
          <p className="hero-sub">
            카탈로그를 올리는 순간부터 고객이 주문하고 다시 찾아오기까지,<br />
            실제로 어떻게 움직이는지 단계별로 보여드려요.
          </p>
        </section>

        <section className="flow" aria-label="사용 단계" style={{ marginTop: 32 }}>
          {STEPS.map((s, i) => (
            <div key={s.no} style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
              <div className="flow-step" style={{ textAlign: 'left' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                  <span className="intro-num" style={{ background: '#111', color: '#FFE500' }}>{s.no}</span>
                  <h3 style={{ margin: 0 }}>{s.title}</h3>
                  <span style={{ marginLeft: 'auto', fontSize: 12, color: 'rgba(17,17,17,0.6)' }}>{s.who}</span>
                </div>
                <p style={{ margin: '0 0 6px' }}>{s.what}</p>
                <p style={{ margin: 0, fontWeight: 700, color: '#111' }}>→ {s.result}</p>
              </div>
              {i < STEPS.length - 1 && <div className="flow-arrow" aria-hidden="true">↓</div>}
            </div>
          ))}
        </section>

        <section className="feature-grid" aria-labelledby="demo-features-title" style={{ marginTop: 48 }}>
          <h2 id="demo-features-title" style={{ gridColumn: '1 / -1', fontSize: 20, fontWeight: 900, color: '#111', margin: '0 0 4px' }}>
            기능 한눈에 보기
          </h2>
          {FEATURES.map((f) => (
            <div key={f.title} className="feature-card">
              <div className="icon" aria-hidden="true">{f.icon}</div>
              <h3>{f.title}</h3>
              <p>{f.desc}</p>
            </div>
          ))}
        </section>

        <section style={{ textAlign: 'center', margin: '48px 0 64px' }}>
          <p style={{ fontSize: 15, color: '#111', fontWeight: 700, margin: '0 0 16px' }}>
            직접 PDF를 올려 보세요. 가입은 무료예요.
          </p>
          <div className="hero-actions" style={{ justifyContent: 'center' }}>
            <Link href="/signup" className="btn btn-coral">무료로 시작하기 - 0원</Link>
            <Link href="/" className="btn btn-dark">처음으로</Link>
          </div>
        </section>
      </main>
    </div>
  )
}
