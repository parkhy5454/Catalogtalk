
'use client'
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export default function Dashboard(){
  const [flipbooks, setFlipbooks] = useState<any[]>([])
  const [title, setTitle] = useState('')
  const [uploading, setUploading] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [selected, setSelected] = useState<any>(null)

  useEffect(()=>{ fetchBooks() }, [])
  async function fetchBooks(){
    const {data} = await supabase.from('flipbooks').select('*').order('created_at', {ascending:false})
    if(data) setFlipbooks(data)
  }
  async function handleUpload(e:any){
    const file = e.target.files[0]
    if(!file) return
    setUploading(true)
    const fileName = `${Date.now()}-${file.name}`
    const {error} = await supabase.storage.from('flipbook-files').upload(fileName, file)
    if(error){ alert('업로드 실패: '+error.message); setUploading(false); return }
    const {data: urlData} = supabase.storage.from('flipbook-files').getPublicUrl(fileName)
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g,'-') + '-' + Date.now().toString().slice(-4)
    const {error: insErr} = await supabase.from('flipbooks').insert({title: title || file.name, slug, pdf_url: urlData.publicUrl, views:0})
    setUploading(false)
    if(insErr) alert(insErr.message)
    else { setTitle(''); fetchBooks(); }
  }

  return (
    <div style={{minHeight:'100vh', minHeight:'100dvh', background:'#0f0a12', color:'#fff', display:'flex', flexDirection:'column'}}>
      <header className="safe-top" style={{display:'flex', alignItems:'center', justifyContent:'space-between', padding:'12px 16px', borderBottom:'1px solid rgba(255,255,255,.07)', position:'sticky', top:0, background:'rgba(15,10,18,.9)', backdropFilter:'blur(20px)', zIndex:10}}>
        <div style={{fontWeight:800, fontSize:16}}>📚 내 플립북</div>
        <div style={{display:'flex', gap:8, alignItems:'center'}}>
          <div style={{fontSize:11, opacity:.5, background:'rgba(255,255,255,.08)', padding:'4px 8px', borderRadius:12}}>0원 운영 중</div>
          <a href="/" style={{color:'#fff', textDecoration:'none', fontSize:13, background:'rgba(255,255,255,.12)', padding:'6px 12px', borderRadius:20}}>홈</a>
        </div>
      </header>

      <main style={{flex:1, padding:'16px', maxWidth:480, margin:'0 auto', width:'100%', overflowY:'auto'}} className="no-scrollbar">
        <div style={{background:'#1a1120', border:'1px solid rgba(255,255,255,.08)', borderRadius:16, padding:16}}>
          <div style={{fontWeight:700, fontSize:14}}>새 플립북 만들기 (모바일)</div>
          <input value={title} onChange={e=>setTitle(e.target.value)} placeholder="제목: 예) CoolAutomation 카탈로그" style={{width:'100%', padding:'12px', borderRadius:12, border:'1px solid rgba(255,255,255,.15)', background:'rgba(255,255,255,.06)', color:'#fff', marginTop:12, fontSize:14}}/>
          <label style={{display:'flex', alignItems:'center', justifyContent:'center', gap:8, width:'100%', padding:'14px', borderRadius:12, border:'1px dashed rgba(255,77,90,.4)', background:'rgba(255,77,90,.08)', color:'#ff8a95', marginTop:12, fontSize:14, fontWeight:600}}>
            📄 PDF 선택 (Supabase 0원 저장)
            <input type="file" accept="application/pdf" onChange={handleUpload} style={{display:'none'}}/>
          </label>
          {uploading && <div style={{marginTop:12, color:'#ff8a95', fontSize:13}}>⏳ 업로드 중... (Supabase Storage 무료)</div>}
          <div style={{fontSize:11, opacity:.4, marginTop:10, lineHeight:1.5}}>• 모바일에서 바로 촬영한 카탈로그도 업로드 가능<br/>• 업로드 후 아이폰처럼 동그랗게 넘어가는 링크 자동 생성<br/>• Vercel Hobby 100GB, Supabase 50GB까지 무료</div>
        </div>

        <div style={{marginTop:20}}>
          <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
            <div style={{fontWeight:700, fontSize:14}}>내 플립북 {flipbooks.length}개</div>
            <div style={{fontSize:11, opacity:.5}}>좌우 스와이프로 관리</div>
          </div>
          <div style={{display:'grid', gap:12, marginTop:12}}>
            {flipbooks.map(fb=>(
              <div key={fb.id} onClick={()=>{setSelected(fb); setSheetOpen(true)}} style={{background:'#1a1120', border:'1px solid rgba(255,255,255,.08)', borderRadius:14, padding:14, display:'flex', gap:12}}>
                <div style={{width:56, height:74, background:'rgba(255,255,255,.08)', borderRadius:8, display:'flex', alignItems:'center', justifyContent:'center', fontSize:20}}>📖</div>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700, fontSize:14, lineHeight:1.3}}>{fb.title}</div>
                  <div style={{fontSize:11, opacity:.5, marginTop:4}}>/b/{fb.slug} • 조회 {fb.views}회</div>
                  <div style={{display:'flex', gap:6, marginTop:8}}>
                    <span style={{background:'#ff4d5a', color:'#fff', padding:'4px 8px', borderRadius:12, fontSize:11}}>보기</span>
                    <span style={{background:'rgba(255,255,255,.1)', padding:'4px 8px', borderRadius:12, fontSize:11}}>복사</span>
                  </div>
                </div>
              </div>
            ))}
            {flipbooks.length===0 && <div style={{textAlign:'center', padding:40, opacity:.4, fontSize:13}}>아직 플립북이 없어요.<br/>위에서 PDF를 올려보세요.</div>}
          </div>
        </div>
      </main>

      {/* Bottom sheet for selected book */}
      <div className={`backdrop ${sheetOpen?'open':''}`} onClick={()=>setSheetOpen(false)}></div>
      <div className={`bottom-sheet ${sheetOpen?'open':''} safe-bottom`}>
        <div style={{width:36, height:4, background:'rgba(255,255,255,.2)', borderRadius:2, margin:'12px auto'}}></div>
        {selected && (
          <div style={{padding:'0 20px 24px'}}>
            <div style={{fontWeight:800, fontSize:16}}>{selected.title}</div>
            <div style={{fontSize:12, opacity:.5, marginTop:4}}>조회 {selected.views}회 • /b/{selected.slug}</div>
            <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginTop:16}}>
              <a href={`/b/${selected.slug}`} target="_blank" style={{background:'#ff4d5a', color:'#fff', padding:'14px', borderRadius:12, textAlign:'center', textDecoration:'none', fontWeight:700, fontSize:14}}>📖 보기</a>
              <button onClick={()=>{navigator.clipboard.writeText(location.origin + '/b/' + selected.slug); alert('링크 복사됨')}} style={{background:'rgba(255,255,255,.12)', color:'#fff', border:0, padding:'14px', borderRadius:12, fontWeight:700, fontSize:14}}>🔗 복사</button>
            </div>
            <div style={{display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8, marginTop:10}}>
              <button style={{background:'rgba(255,255,255,.06)', border:0, color:'#fff', padding:'10px', borderRadius:10, fontSize:12}}>카톡 공유</button>
              <button style={{background:'rgba(255,255,255,.06)', border:0, color:'#fff', padding:'10px', borderRadius:10, fontSize:12}}>QR 생성</button>
              <button style={{background:'rgba(255,80,80,.15)', border:0, color:'#ff8a95', padding:'10px', borderRadius:10, fontSize:12}}>삭제</button>
            </div>
            <div style={{marginTop:16, background:'rgba(255,255,255,.05)', padding:12, borderRadius:10, fontSize:11, lineHeight:1.6, opacity:.7}}>
              <b>모바일 팁:</b> 이 링크를 카톡으로 보내면 상대방은 앱 설치 없이 아이폰 도서처럼 동그랗게 말리며 볼 수 있어요.<br/>
              비용: Vercel 0원 + Supabase 0원 (50곳까지)
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
