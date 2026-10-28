
'use client'
import Link from 'next/link'
import { useState } from 'react'

export default function Home(){
  const [sheetOpen, setSheetOpen] = useState(false)
  return (
    <div style={{minHeight:'100vh', minHeight:'100dvh', background:'radial-gradient(ellipse at 30% 20%,#2e1c3a 0%,#0f0a12 60%)', color:'#fff', display:'flex', flexDirection:'column'}}>
      <header className="safe-top" style={{display:'flex', justifyContent:'space-between', alignItems:'center', padding:'14px 20px', borderBottom:'1px solid rgba(255,255,255,.07)', position:'sticky', top:0, backdropFilter:'blur(20px)', background:'rgba(15,10,18,0.8)', zIndex:10}}>
        <div style={{fontWeight:900, letterSpacing:-0.5, color:'#ff5a6a', fontSize:18}}>FLIPBOOK</div>
        <div style={{display:'flex', gap:8}}>
          <button onClick={()=>setSheetOpen(true)} style={{background:'rgba(255,255,255,.12)', border:0, color:'#fff', padding:'8px 14px', borderRadius:20, fontSize:13, fontWeight:600}}>요금제</button>
          <Link href="/dashboard" style={{background:'#ff4d5a', color:'#fff', padding:'8px 16px', borderRadius:20, fontSize:13, fontWeight:700, textDecoration:'none'}}>시작하기</Link>
        </div>
      </header>

      <main style={{flex:1, padding:'0 20px 20px', maxWidth:480, margin:'0 auto', width:'100%'}}>
        <div style={{marginTop:28, background:'rgba(255,90,106,.12)', border:'1px solid rgba(255,90,106,.2)', color:'#ff8a95', padding:'7px 12px', borderRadius:20, fontSize:12, display:'inline-flex', alignItems:'center', gap:6}}>
          <span style={{width:6, height:6, background:'#ff5a6a', borderRadius:'50%', display:'inline-block'}}></span> 아이폰 도서처럼 동그랗게 말리며 넘어감
        </div>
        <h1 style={{fontSize:34, lineHeight:1.18, fontWeight:800, letterSpacing:-1, marginTop:18}}>PDF를<br/>카톡에서<br/>바로 보는<br/><span style={{color:'#ff5a6a'}}>플립북 링크</span>로</h1>
        <p style={{opacity:.62, fontSize:15, lineHeight:1.6, marginTop:14}}>고객은 앱 설치 없이 카톡에서 바로 봅니다.<br/>누가 얼마나 봤는지 실시간 추적까지.</p>

        <div style={{marginTop:24, background:'#1a1120', border:'1px solid rgba(255,255,255,.08)', borderRadius:16, overflow:'hidden'}}>
          <div style={{padding:'12px 16px', borderBottom:'1px solid rgba(255,255,255,.06)', display:'flex', justifyContent:'space-between', alignItems:'center'}}>
            <div style={{fontSize:12, opacity:.5}}>미리보기 - 아이폰에서 이렇게 보입니다</div>
            <div style={{display:'flex', gap:4}}><div style={{width:8,height:8,borderRadius:'50%',background:'#ff5f57'}}></div><div style={{width:8,height:8,borderRadius:'50%',background:'#ffbd2e'}}></div><div style={{width:8,height:8,borderRadius:'50%',background:'#28ca42'}}></div></div>
          </div>
          <div style={{aspectRatio:'9/13', background:'#000', position:'relative'}}>
            <iframe src="/sample-flipbook.html" style={{width:'100%', height:'100%', border:0}} loading="lazy" title="flipbook preview" />
            <div style={{position:'absolute', bottom:12, left:'50%', transform:'translateX(-50%)', background:'rgba(0,0,0,.75)', padding:'6px 12px', borderRadius:20, fontSize:11, backdropFilter:'blur(10px)'}}>👆 모서리를 잡고 당겨보세요</div>
          </div>
        </div>

        <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginTop:16}}>
          <div style={{background:'rgba(255,255,255,.06)', borderRadius:12, padding:14}}><div style={{fontSize:20}}>📱</div><div style={{fontSize:13, fontWeight:700, marginTop:6}}>모바일 최적화</div><div style={{fontSize:11, opacity:.5, marginTop:4, lineHeight:1.4}}>아이폰 제스처 100%<br/>동그란 말림 + 소리</div></div>
          <div style={{background:'rgba(255,255,255,.06)', borderRadius:12, padding:14}}><div style={{fontSize:20}}>📊</div><div style={{fontSize:13, fontWeight:700, marginTop:6}}>조회수 추적</div><div style={{fontSize:11, opacity:.5, marginTop:4, lineHeight:1.4}}>누가 몇 초 봤는지<br/>실시간 알림</div></div>
          <div style={{background:'rgba(255,255,255,.06)', borderRadius:12, padding:14}}><div style={{fontSize:20}}>🔗</div><div style={{fontSize:13, fontWeight:700, marginTop:6}}>카톡 공유</div><div style={{fontSize:11, opacity:.5, marginTop:4, lineHeight:1.4}}>링크 하나로<br/>썸네일 예쁘게</div></div>
          <div style={{background:'rgba(255,255,255,.06)', borderRadius:12, padding:14}}><div style={{fontSize:20}}>💰</div><div style={{fontSize:13, fontWeight:700, marginTop:6}}>0원 운영</div><div style={{fontSize:11, opacity:.5, marginTop:4, lineHeight:1.4}}>Vercel+Supabase<br/>무료 플랜</div></div>
        </div>

        <Link href="/dashboard" style={{display:'flex', alignItems:'center', justifyContent:'center', gap:8, background:'#ff4d5a', color:'#fff', padding:'16px', borderRadius:16, textDecoration:'none', fontWeight:800, fontSize:16, marginTop:20}}>
          무료로 시작하기 - 0원 <span style={{opacity:.8}}>→</span>
        </Link>
        <div style={{textAlign:'center', fontSize:11, opacity:.35, marginTop:10}}>GitHub + Vercel + Supabase 무료 플랜 • 고객 50곳까지 0원</div>
      </main>

      {/* Bottom sheet - pricing */}
      <div className={`backdrop ${sheetOpen?'open':''}`} onClick={()=>setSheetOpen(false)}></div>
      <div className={`bottom-sheet ${sheetOpen?'open':''} safe-bottom`}>
        <div style={{width:36, height:4, background:'rgba(255,255,255,.2)', borderRadius:2, margin:'12px auto'}}></div>
        <div style={{padding:'0 20px 24px'}}>
          <h3 style={{fontSize:18, fontWeight:800}}>요금제 (모바일 최적화)</h3>
          <p style={{fontSize:12, opacity:.5, marginTop:4}}>Vercel + Supabase 0원 운영, Neon+R2로 가면 더 싸요</p>
          <div style={{display:'grid', gap:12, marginTop:16}}>
            <div style={{border:'1px solid rgba(255,255,255,.12)', borderRadius:12, padding:16}}><div style={{display:'flex', justifyContent:'space-between'}}><b>Free</b><b>0원</b></div><div style={{fontSize:12, opacity:.6, marginTop:6}}>플립북 3개 • 월 1천뷰 • Supabase 무료</div></div>
            <div style={{border:'1px solid #ff4d5a', background:'rgba(255,77,90,.08)', borderRadius:12, padding:16}}><div style={{display:'flex', justifyContent:'space-between'}}><b>Starter ⭐추천</b><b>29,000원/월</b></div><div style={{fontSize:12, opacity:.7, marginTop:6}}>플립북 20개 • 월 1만뷰 • 조회수 추적 • 카톡 썸네일</div></div>
            <div style={{border:'1px solid rgba(255,255,255,.12)', borderRadius:12, padding:16}}><div style={{display:'flex', justifyContent:'space-between'}}><b>Pro</b><b>79,000원/월</b></div><div style={{fontSize:12, opacity:.6, marginTop:6}}>무제한 • 월 10만뷰 • 리드 수집 • API • R2 이전 포함</div></div>
          </div>
          <table style={{width:'100%', fontSize:11, marginTop:16, borderCollapse:'collapse', opacity:.7}}>
            <tr style={{borderBottom:'1px solid rgba(255,255,255,.08)'}}><th style={{textAlign:'left', padding:'8px 0'}}>스택</th><th>무료</th><th>월 200곳</th></tr>
            <tr><td style={{padding:'8px 0'}}>Vercel+Supabase</td><td>$0</td><td>$25</td></tr>
            <tr><td style={{padding:'8px 0'}}>Vercel+Neon+R2</td><td>$0</td><td>$20</td></tr>
            <tr><td style={{padding:'8px 0'}}>CF Pages+R2+D1</td><td>$0</td><td>$1.5</td></tr>
          </table>
          <Link href="/dashboard" style={{display:'block', background:'#ff4d5a', color:'#fff', textAlign:'center', padding:'14px', borderRadius:12, textDecoration:'none', fontWeight:700, marginTop:16}}>시작하기</Link>
        </div>
      </div>
    </div>
  )
}
