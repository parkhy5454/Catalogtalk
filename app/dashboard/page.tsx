
'use client'
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export default function Dashboard(){
  const [flipbooks, setFlipbooks] = useState<any[]>([])
  const [title, setTitle] = useState('')
  const [uploading, setUploading] = useState(false)

  useEffect(()=>{ fetchBooks() }, [])
  async function fetchBooks(){
    const {data} = await supabase.from('flipbooks').select('*').order('created_at', {ascending:false})
    if(data) setFlipbooks(data)
  }

  async function handleUpload(e:any){
    const file = e.target.files[0]
    if(!file) return
    setUploading(true)
    // 1. Supabase Storage에 PDF 업로드
    const fileName = `${Date.now()}-${file.name}`
    const {data: upData, error: upErr} = await supabase.storage.from('flipbook-files').upload(fileName, file)
    if(upErr){ alert('업로드 실패: '+upErr.message); setUploading(false); return }
    const {data: urlData} = supabase.storage.from('flipbook-files').getPublicUrl(fileName)
    
    // 2. flipbooks 테이블에 생성 (실제로는 서버에서 PDF를 이미지로 변환해야 하지만 MVP는 바로 생성)
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g,'-') + '-' + Date.now().toString().slice(-4)
    const {data, error} = await supabase.from('flipbooks').insert({
      title: title || file.name,
      slug,
      pdf_url: urlData.publicUrl,
      views: 0
    }).select().single()
    setUploading(false)
    if(error) alert(error.message)
    else { setTitle(''); fetchBooks(); alert('생성 완료! 링크: /b/' + slug) }
  }

  return (
    <div style={{minHeight:'100vh', background:'#0f0a12', color:'#fff', padding:24}}>
      <h1 style={{fontSize:22, fontWeight:800}}>📚 내 플립북 대시보드 (Supabase 연동)</h1>
      <p style={{opacity:.6, fontSize:13, marginTop:8}}>PDF를 올리면 아이폰처럼 동그랗게 넘어가는 플립북 링크가 생성됩니다. Vercel + Supabase 무료 플랜으로 운영 중.</p>
      
      <div style={{marginTop:24, background:'#1a1120', padding:20, borderRadius:12, border:'1px solid rgba(255,255,255,.08)'}}>
        <h3>새 플립북 만들기</h3>
        <input value={title} onChange={e=>setTitle(e.target.value)} placeholder="제목 (예: CoolAutomation 2024 카탈로그)" style={{width:'100%', padding:'12px', borderRadius:8, border:'1px solid rgba(255,255,255,.15)', background:'rgba(255,255,255,.05)', color:'#fff', marginTop:12}}/>
        <input type="file" accept="application/pdf" onChange={handleUpload} style={{marginTop:12}}/>
        {uploading && <div style={{marginTop:12, color:'#ff8a95'}}>⏳ 업로드 중... Supabase Storage로 업로드 중 (0원)</div>}
      </div>

      <div style={{marginTop:32, display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(280px,1fr))', gap:16}}>
        {flipbooks.map(fb=>(
          <div key={fb.id} style={{background:'#1a1120', border:'1px solid rgba(255,255,255,.08)', borderRadius:12, padding:16}}>
            <div style={{fontWeight:700}}>{fb.title}</div>
            <div style={{fontSize:12, opacity:.5, marginTop:4}}>/b/{fb.slug} • 조회 {fb.views}회</div>
            <div style={{marginTop:12, display:'flex', gap:8}}>
              <a href={`/b/${fb.slug}`} target="_blank" style={{background:'#ff4d5a', color:'#fff', padding:'8px 14px', borderRadius:20, textDecoration:'none', fontSize:12}}>보기</a>
              <button onClick={()=>{navigator.clipboard.writeText(location.origin + '/b/' + fb.slug); alert('링크 복사됨')}} style={{background:'rgba(255,255,255,.12)', color:'#fff', border:0, padding:'8px 14px', borderRadius:20, fontSize:12}}>링크 복사</button>
            </div>
          </div>
        ))}
      </div>

      <div style={{marginTop:40, background:'rgba(255,255,255,.05)', padding:16, borderRadius:12, fontSize:12, lineHeight:1.7}}>
        <b>🔧 Supabase 설정 (1분)</b><br/>
        1. supabase.com 에서 프로젝트 생성 (무료)<br/>
        2. SQL Editor에 supabase/schema.sql 붙여넣기<br/>
        3. Storage에서 flipbook-files 버킷을 Public으로 생성<br/>
        4. .env.local에 NEXT_PUBLIC_SUPABASE_URL, ANON_KEY 넣기<br/>
        5. Vercel에 GitHub 연결하면 자동 배포 (0원)<br/><br/>
        <b>비용:</b> Vercel Hobby 0원 + Supabase Free 0원 = 월 0원 (고객 50곳까지)<br/>
        고객 200곳 넘어가면 Supabase Pro $25 또는 Neon+R2로 이전 (월 2만원대)
      </div>
    </div>
  )
}
