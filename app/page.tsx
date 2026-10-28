import Link from 'next/link'

export default function Home() {
  return (
    <div style={{minHeight:'100vh', background:'radial-gradient(ellipse at 50% 0%, #2a1840 0%, #0e0a14 60%)', color:'white'}}>
      <header style={{display:'flex', justifyContent:'space-between', alignItems:'center', padding:'20px 24px', maxWidth:'1100px', margin:'0 auto'}}>
        <div style={{fontWeight:900, letterSpacing:'-0.5px', color:'#ff5a6a'}}>CATALOGTALK</div>
        <div style={{display:'flex', gap:'8px'}}>
          <Link href="/login" style={{color:'white', textDecoration:'none', padding:'8px 16px', borderRadius:'20px', border:'1px solid rgba(255,255,255,0.2)', fontSize:'13px'}}>로그인</Link>
          <Link href="/signup" style={{background:'white', color:'black', textDecoration:'none', padding:'8px 16px', borderRadius:'20px', fontSize:'13px', fontWeight:700}}>회원가입</Link>
        </div>
      </header>

      <main style={{maxWidth:'1100px', margin:'0 auto', padding:'80px 24px 60px', textAlign:'center'}}>
        <div style={{display:'inline-block', background:'rgba(255,90,106,0.15)', color:'#ff8a95', padding:'6px 14px', borderRadius:'20px', fontSize:'12px', fontWeight:600, marginBottom:'20px'}}>
          아이폰 도서처럼 동그랗게 말리며 넘어가는 플립북
        </div>
        <h1 style={{fontSize:'clamp(32px, 6vw, 52px)', lineHeight:'1.1', fontWeight:900, letterSpacing:'-1px', marginBottom:'18px'}}>
          PDF 카탈로그를<br/>카톡에서 바로 보는<br/><span style={{color:'#ff5a6a'}}>플립북 링크</span>로
        </h1>
        <p style={{opacity:0.7, fontSize:'16px', lineHeight:'1.6', marginBottom:'32px'}}>
          고객은 앱 설치 없이 카톡에서 바로 봅니다.<br/>누가 몇 초 봤는지, 어디서 이탈했는지 실시간으로 알 수 있어요.
        </p>
        <div style={{display:'flex', gap:'12px', justifyContent:'center', flexWrap:'wrap', marginBottom:'80px'}}>
          <Link href="/signup" style={{background:'#ff4d5a', color:'white', padding:'14px 28px', borderRadius:'28px', textDecoration:'none', fontWeight:700}}>무료로 시작하기 - 0원</Link>
          <a href="#demo" style={{background:'rgba(255,255,255,0.12)', color:'white', padding:'14px 28px', borderRadius:'28px', textDecoration:'none', fontWeight:600}}>데모 보기</a>
        </div>

        <div id="demo" style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(240px, 1fr))', gap:'16px', textAlign:'left'}}>
          <div style={{background:'rgba(255,255,255,0.06)', border:'1px solid rgba(255,255,255,0.08)', borderRadius:'16px', padding:'20px'}}>
            <div style={{fontSize:'20px', marginBottom:'8px'}}>⚡️</div>
            <div style={{fontWeight:700, marginBottom:'6px'}}>3초 변환</div>
            <div style={{fontSize:'13px', opacity:0.7}}>PDF 업로드하면 3초 만에 카톡 공유용 링크 생성</div>
          </div>
          <div style={{background:'rgba(255,255,255,0.06)', border:'1px solid rgba(255,255,255,0.08)', borderRadius:'16px', padding:'20px'}}>
            <div style={{fontSize:'20px', marginBottom:'8px'}}>📊</div>
            <div style={{fontWeight:700, marginBottom:'6px'}}>조회수 추적</div>
            <div style={{fontSize:'13px', opacity:0.7}}>누가 언제 봤는지, 몇 페이지까지 봤는지 실시간 추적</div>
          </div>
          <div style={{background:'rgba(255,255,255,0.06)', border:'1px solid rgba(255,255,255,0.08)', borderRadius:'16px', padding:'20px'}}>
            <div style={{fontSize:'20px', marginBottom:'8px'}}>💬</div>
            <div style={{fontWeight:700, marginBottom:'6px'}}>카톡 최적화</div>
            <div style={{fontSize:'13px', opacity:0.7}}>오픈그래프 썸네일, 카톡에서 예쁘게 보이는 링크</div>
          </div>
        </div>

        <div style={{marginTop:'60px', padding:'24px', background:'rgba(255,255,255,0.04)', borderRadius:'16px', textAlign:'left'}}>
          <h3 style={{marginBottom:'12px', fontSize:'14px'}}>💰 운영 비용 (프로덕션)</h3>
          <div style={{fontSize:'13px', opacity:0.7, lineHeight:'1.7'}}>
            Vercel Hobby $0 + Supabase Free $0 = 월 0원 (고객 50곳까지)<br/>
            고객 200곳 이상: Supabase Pro $25 또는 Cloudflare R2 + Neon으로 이전 (월 $7~$20)<br/>
            <br/>• 무료 플랜: 0.5GB DB, 1GB 스토리지, 50GB 대역폭<br/>• RLS 보안 활성화, 고객별 데이터 격리, 감사 로그 포함
          </div>
        </div>
      </main>
    </div>
  )
}