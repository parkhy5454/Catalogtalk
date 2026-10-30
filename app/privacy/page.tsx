// Public privacy policy (개인정보 처리방침). No sign-in needed.
import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: '개인정보 처리방침',
  robots: { index: true, follow: true },
}

const EFFECTIVE = '2026년 10월 30일'

export default function PrivacyPage() {
  return (
    <main className="container section" style={{ lineHeight: 1.7 }}>
      <section className="panel">
        <h1 className="panel-title">개인정보 처리방침</h1>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>시행일: {EFFECTIVE}</p>

        <Block title="1. 수집하는 개인정보">
          <ul>
            <li>회원가입 시: 이메일, 비밀번호(암호화하여 저장), 이름, 휴대폰 번호, 회사명(입력한 경우)</li>
            <li>서비스 이용 시: 카탈로그 조회 기록(기기 종류, 방문 식별값, 방문 시각, 본 페이지 번호, 페이지별 체류 시간)</li>
            <li>보안 목적: 접속 기록과 IP 주소를 서비스 호스팅 사업자가 남길 수 있어요</li>
            <li>부정 이용 방지: 가입 시 접속 주소를 해시(복원할 수 없는 값)로 바꿔 보관해요. 원래 주소는 저장하지 않아요.</li>
          </ul>
        </Block>

        <Block title="2. 수집 목적">
          <ul>
            <li>회원 식별, 가입과 로그인, 본인 확인</li>
            <li>플립북 제작·공유 서비스 제공, 조회 통계 제공</li>
            <li>추천 보상 지급, 부정 이용 방지, 고객 문의 대응</li>
          </ul>
        </Block>

        <Block title="3. 보관 기간">
          <ul>
            <li>회원 탈퇴 시 개인정보와 카탈로그, 공유 링크, 조회 기록, 가입 주소 해시를 즉시 삭제해요.</li>
            <li>가입 주소 해시는 가입 확인 전 임시 기록을 포함해 30일이 지나면 자동으로 지워요.</li>
            <li>조회 기록은 수집일로부터 365일이 지나면 자동으로 삭제해요.</li>
            <li>
              관계 법령에 따라 보관이 필요한 정보는 해당 기간 동안만 보관하고, 그 뒤 삭제해요. 예: 계약·결제 기록 5년,
              소비자 불만·분쟁 처리 기록 3년, 접속 기록 1년 이상(안전성 확보조치 기준).
            </li>
          </ul>
        </Block>

        <Block title="4. 처리 위탁 및 국외 이전">
          <p>서비스 운영을 위해 아래 사업자에게 개인정보 저장과 처리를 맡겨요.</p>
          <ul>
            <li>Supabase: 회원 정보, 카탈로그 파일, 조회 기록 저장</li>
            <li>Vercel: 웹 서비스 호스팅</li>
          </ul>
          <p>위 사업자의 서버는 국외에 있을 수 있어요.</p>
        </Block>

        <Block title="5. 쿠키와 브라우저 저장소">
          <p>
            개인정보 안내 확인 여부, 페이지 넘김 소리 설정, 오프라인 보기를 위한 저장 공간을 브라우저에 저장해요. 브라우저
            설정에서 삭제할 수 있어요.
          </p>
        </Block>

        <Block title="6. 이용자의 권리">
          <p>
            이용자는 개인정보의 열람, 정정, 삭제, 처리정지를 요청할 수 있어요. 회원 탈퇴는 설정 메뉴에서 직접 할 수
            있고, 그 밖의 요청은 아래 보호책임자에게 이메일로 보내 주세요.
          </p>
        </Block>

        <Block title="7. 개인정보 보호책임자">
          <ul>
            <li>성명: 박현용</li>
            <li>이메일: w_ks@daum.net</li>
            <li>전화: 02-971-0954</li>
          </ul>
        </Block>

        <Block title="8. 사업자 정보">
          <ul>
            <li>상호: (주)카이저솔루션</li>
            <li>사업자등록번호: 217-81-35654</li>
            <li>대표: 박현용</li>
            <li>주소: 경기도 남양주시 순화궁로 272, 519호(별내동, 동광비즈타워)</li>
          </ul>
        </Block>

        <p style={{ marginTop: 24 }}>
          <Link href="/" className="btn btn-ghost">홈으로</Link>
        </p>
      </section>
    </main>
  )
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 20 }}>
      <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>{title}</h2>
      <div style={{ fontSize: 14 }}>{children}</div>
    </section>
  )
}
