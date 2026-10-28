
'use client'
import { useState } from 'react'
import Link from 'next/link'

export default function Home(){
  return (
    <div style={{minHeight:'100vh', background:'radial-gradient(ellipse at center,#2e1c3a 0%,#0f0a12 80%)', color:'#fff'}}>
      <header style={{display:'flex', justifyContent:'space-between', alignItems:'center', padding:'16px 24px', position:'sticky', top:0, zIndex:10, background:'rgba(10,10,20,0.8)', backdropFilter:'blur(12px)', borderBottom:'1px solid rgba(255,255,255,0.06)'}}>
      <a href="/" style={{display:'flex', alignItems:'center', gap:'8px', textDecoration:'none'}}>
        <div style={{color:'#FF5A5F', fontWeight:900, fontSize:'16px', letterSpacing:'-0.5px'}}>FLIPBOOK.KR</div>
      </a>
      <div style={{display:'flex', gap:'8px', alignItems:'center'}}>
        <a href="/login" style={{color:'white', textDecoration:'none', fontSize:'13px', padding:'8px 16px', borderRadius:'20px', border:'1px solid rgba(255,255,255,0.2)'}}>로그인</a>
        <a href="/signup" style={{background:'white', color:'black', textDecoration:'none', fontSize:'13px', padding:'8px 16px', borderRadius:'20px', fontWeight:700}}>회원가입</a>
        <a href="/dashboard" style={{background:'rgba(255,255,255,0.1)', color:'white', textDecoration:'none', fontSize:'13px', padding:'8px 16px', borderRadius:'20px'}}>대시보드</a>
      </div>
    </header>
      <main style={{maxWidth:960, margin:'0 auto', padding:'80px 24px', textAlign:'center'}}>
        <div style={{display:'inline-block', background:'rgba(255,90,106,.15)', color:'#ff8a95', padding:'6px 14px', borderRadius:20, fontSize:12, marginBottom:20}}>아이폰 도서처럼 동그랗게 말리며 넘어가는 플립북</div>
        <h1 style={{fontSize:48, lineHeight:1.15, marginBottom:18}}>PDF 카탈로그를<br/>카톡에서 바로 보는<br/><span style={{color:'#ff5a6a'}}>플립북 링크</span>로</h1>
        <p style={{opacity:.65, fontSize:16, lineHeight:1.6, marginBottom:32}}>고객은 앱 설치 없이 카톡에서 바로 봅니다.<br/>누가 몇 초 봤는지, 어디서 이탈했는지 실시간으로 알 수 있어요.</p>
        <div style={{display:'flex', gap:12, justifyContent:'center', marginBottom:60}}>
          <Link href="/dashboard" style={{background:'#ff4d5a', color:'#fff', padding:'14px 28px', borderRadius:28, textDecoration:'none', fontWeight:700}}>무료로 시작하기 - 0원</Link>
          <a href="#demo" style={{background:'rgba(255,255,255,.12)', color:'#fff', padding:'14px 28px', borderRadius:28, textDecoration:'none'}}>데모 보기</a>
        </div>
        <div id="demo" style={{background:'#1a1120', border:'1px solid rgba(255,255,255,.08)', borderRadius:16, padding:24, textAlign:'left'}}>
          <h3 style={{marginBottom:12}}>💰 요금제 (Vercel + Supabase 0원 운영)</h3>
          <div style={{display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12}}>
            <div style={{background:'rgba(255,255,255,.05)', padding:16, borderRadius:12}}><div style={{fontWeight:700}}>Free</div><div style={{fontSize:24, fontWeight:800, margin:'8px 0'}}>0원</div><div style={{fontSize:12, opacity:.6}}>플립북 3개<br/>월 뷰 1000회<br/>Supabase 무료</div></div>
            <div style={{background:'#ff4d5a', padding:16, borderRadius:12}}><div style={{fontWeight:700}}>Starter</div><div style={{fontSize:24, fontWeight:800, margin:'8px 0'}}>29,000원</div><div style={{fontSize:12}}>플립북 20개<br/>월 뷰 1만회<br/>조회수 추적</div></div>
            <div style={{background:'rgba(255,255,255,.05)', padding:16, borderRadius:12}}><div style={{fontWeight:700}}>Pro</div><div style={{fontSize:24, fontWeight:800, margin:'8px 0'}}>79,000원</div><div style={{fontSize:12, opacity:.6}}>플립북 무제한<br/>월 뷰 10만회<br/>리드 수집 + API</div></div>
          </div>
        </div>
        <div style={{marginTop:40, fontSize:12, opacity:.4}}>GitHub + Vercel Hobby + Supabase Free = 월 0원 운영 가능. 고객 50곳까지 무료.</div>
      </main>
    </div>
  )
}
