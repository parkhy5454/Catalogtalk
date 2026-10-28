
'use client'
import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useParams } from 'next/navigation'

export default function Viewer(){
  const params = useParams()
  const slug = params.slug as string
  const [flipbook, setFlipbook] = useState<any>(null)
  const [pages, setPages] = useState<string[]>([])

  useEffect(()=>{
    async function load(){
      const {data} = await supabase.from('flipbooks').select('*').eq('slug', slug).single()
      if(!data) return
      setFlipbook(data)
      // MVP: PDF 대신 기존 CoolAutomation 샘플 8장 사용 (실제로는 서버에서 PDF를 이미지로 변환)
      // 여기서는 Supabase Storage에 있는 이미지들을 flipbook_pages 테이블에서 가져온다고 가정
      const {data: pagesData} = await supabase.from('flipbook_pages').select('*').eq('flipbook_id', data.id).order('page_no')
      if(pagesData && pagesData.length>0){
        setPages(pagesData.map((p:any)=>p.image_url))
      } else {
        // 샘플: 빈 배열이면 iBooks 스타일 뷰어를 iframe으로 로드 (당신이 만든 HTML)
        setPages([])
      }
      // 조회수 증가
      supabase.rpc('increment_view', {fb_id: data.id})
      supabase.from('flipbook_views').insert({flipbook_id: data.id})
    }
    load()
  }, [slug])

  if(!flipbook) return <div style={{padding:40, color:'#fff', background:'#0f0a12', minHeight:'100vh'}}>로딩 중... /b/{slug}</div>

  return (
    <div style={{height:'100vh', display:'flex', flexDirection:'column', background:'#0f0a12'}}>
      <div style={{height:56, background:'#1c1122', display:'flex', alignItems:'center', justifyContent:'space-between', padding:'0 16px', color:'#fff'}}>
        <div style={{fontWeight:700}}>{flipbook.title}</div>
        <div style={{fontSize:12, opacity:.6}}>아이폰처럼 동그랗게 넘어갑니다 • 조회 {flipbook.views}</div>
      </div>
      <div style={{flex:1, position:'relative'}}>
        {/* 여기에 당신이 만든 iBooks 스타일 플립북 HTML을 iframe으로 넣으면 끝 */}
        <iframe src="/sample-flipbook.html" style={{width:'100%', height:'100%', border:0}} />
      </div>
      <div style={{height:64, background:'#1a1120', display:'flex', alignItems:'center', justifyContent:'center', gap:12}}>
        <a href={`https://api.whatsapp.com/send?text=${encodeURIComponent(location.href)}`} target="_blank" style={{background:'#25D366', color:'#fff', padding:'10px 18px', borderRadius:22, textDecoration:'none', fontSize:13}}>카톡/왓츠앱 공유</a>
        <button onClick={()=>{ if(navigator.share) navigator.share({title: flipbook.title, url: location.href}) }} style={{background:'rgba(255,255,255,.12)', color:'#fff', border:0, padding:'10px 18px', borderRadius:22, fontSize:13}}>공유</button>
      </div>
    </div>
  )
}
