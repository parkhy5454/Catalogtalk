
'use client'
import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useParams } from 'next/navigation'

export default function Viewer(){
  const params = useParams()
  const slug = params.slug as string
  const [flipbook, setFlipbook] = useState<any>(null)
  const [sheetOpen, setSheetOpen] = useState(false)

  useEffect(()=>{
    async function load(){
      const {data} = await supabase.from('flipbooks').select('*').eq('slug', slug).single()
      if(!data) return
      setFlipbook(data)
      supabase.rpc('increment_view', {fb_id: data.id})
      supabase.from('flipbook_views').insert({flipbook_id: data.id})
    }
    load()
  }, [slug])

  if(!flipbook) return <div style={{padding:40, color:'#fff', background:'#0f0a12', minHeight:'100vh', minHeight:'100dvh'}}>로딩 중... /b/{slug}</div>

  return (
    <div style={{height:'100vh', height:'100dvh', display:'flex', flexDirection:'column', background:'#0f0a12', overscrollBehavior:'none'}}>
      <header className="safe-top" style={{height:48, background:'rgba(28,17,34,0.9)', backdropFilter:'blur(20px)', display:'flex', alignItems:'center', justifyContent:'space-between', padding:'0 14px', color:'#fff', borderBottom:'1px solid rgba(255,255,255,.06)', position:'sticky', top:0, zIndex:10}}>
        <div style={{display:'flex', alignItems:'center', gap:10}}>
          <button onClick={()=>history.back()} style={{background:'rgba(255,255,255,.12)', border:0, color:'#fff', width:32, height:32, borderRadius:'50%', fontSize:16}}>‹</button>
          <div style={{fontWeight:700, fontSize:14, maxWidth:180, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>{flipbook.title}</div>
        </div>
        <div style={{display:'flex', gap:8, alignItems:'center'}}>
          <div style={{fontSize:11, opacity:.5, background:'rgba(255,255,255,.08)', padding:'4px 8px', borderRadius:12}}>조회 {flipbook.views}</div>
          <button onClick={()=>setSheetOpen(true)} style={{background:'#ff4d5a', border:0, color:'#fff', padding:'6px 12px', borderRadius:20, fontSize:12, fontWeight:700}}>공유</button>
        </div>
      </header>

      <div style={{flex:1, position:'relative', background:'radial-gradient(ellipse at center,#2e1c3a 0%,#0f0a12 70%)'}}>
        <iframe src="/sample-flipbook.html" style={{width:'100%', height:'100%', border:0}} allow="autoplay" title="flipbook" />
        <div style={{position:'absolute', bottom:14, left:'50%', transform:'translateX(-50%)', background:'rgba(0,0,0,.72)', color:'#fff', padding:'8px 14px', borderRadius:20, fontSize:12, backdropFilter:'blur(12px)', display:'flex', alignItems:'center', gap:6, pointerEvents:'none'}}>
          <span>👆</span> 아래 모서리 잡고 당기면 동그랗게 말립니다
        </div>
      </div>

      <div className={`backdrop ${sheetOpen?'open':''}`} onClick={()=>setSheetOpen(false)}></div>
      <div className={`bottom-sheet ${sheetOpen?'open':''} safe-bottom`}>
        <div style={{width:36, height:4, background:'rgba(255,255,255,.2)', borderRadius:2, margin:'12px auto'}}></div>
        <div style={{padding:'0 20px 24px'}}>
          <div style={{fontWeight:800, fontSize:16}}>{flipbook.title}</div>
          <div style={{fontSize:12, opacity:.5, marginTop:4}}>이 플립북은 아이폰 도서처럼 동그랗게 말리며 넘어갑니다</div>
          <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginTop:16}}>
            <a href={`https://api.whatsapp.com/send?text=${encodeURIComponent(location.href)}`} target="_blank" style={{background:'#25D366', color:'#fff', padding:'14px', borderRadius:12, textAlign:'center', textDecoration:'none', fontWeight:700, fontSize:14}}>카톡/왓츠앱 공유</a>
            <button onClick={()=>{navigator.clipboard.writeText(location.href); alert('링크 복사됨')}} style={{background:'rgba(255,255,255,.12)', color:'#fff', border:0, padding:'14px', borderRadius:12, fontWeight:700, fontSize:14}}>🔗 링크 복사</button>
          </div>
          <button onClick={()=>{ if(navigator.share) navigator.share({title: flipbook.title, url: location.href}) }} style={{width:'100%', background:'rgba(255,255,255,.08)', color:'#fff', border:0, padding:'14px', borderRadius:12, fontWeight:700, fontSize:14, marginTop:10}}>📤 시스템 공유 시트 열기 (아이폰)</button>
          <div style={{marginTop:14, fontSize:11, opacity:.5, lineHeight:1.6, textAlign:'center'}}>Vercel Hobby 100GB + Supabase 50GB까지 0원 운영 • 조회수 추적 포함</div>
        </div>
      </div>
    </div>
  )
}
