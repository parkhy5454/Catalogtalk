'use client'
export const dynamic = 'force-dynamic'
import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'

export default function Dashboard(){
  const [flipbooks, setFlipbooks] = useState<any[]>([])
  const [title, setTitle] = useState('')
  const [uploading, setUploading] = useState(false)
  const [user, setUser] = useState<any>(null)

  useEffect(()=>{
    const init = async () => {
      const {data:{user}} = await supabase.auth.getUser()
      if(!user){ window.location.href='/login'; return }
      setUser(user)
      const {data} = await supabase.from('flipbooks').select('*').order('created_at', {ascending:false})
      if(data) setFlipbooks(data)
    }
    init()
  }, [])

  const handleUpload = async (e:any) => {
    const file = e.target.files[0]
    if(!file) return
    if(!title){ alert('제목을 먼저 입력하세요'); return }
    setUploading(true)
    try{
      const fileName = `${Date.now()}-${file.name}`
      const {data: upData, error: upErr} = await supabase.storage.from('flipbook-files').upload(fileName, file)
      if(upErr) throw upErr
      const {data: urlData} = supabase.storage.from('flipbook-files').getPublicUrl(fileName)
      const slug = title.toLowerCase().replace(/[^a-z0-9가-힣]+/g,'-').replace(/^-|-$/g,'') + '-' + Date.now().toString().slice(-4)
      const {data, error} = await supabase.from('flipbooks').insert({
        title, slug, pdf_url: urlData.publicUrl, status:'ready'
      }).select().single()
      if(error) throw error
      alert('업로드 완료! 링크: /b/' + slug)
      setTitle('')
      const {data: newData} = await supabase.from('flipbooks').select('*').order('created_at', {ascending:false})
      if(newData) setFlipbooks(newData)
    }catch(err:any){
      alert('오류: ' + err.message)
    }
    setUploading(false)
  }

  const handleLogout = async () => {
    await supabase.auth.signOut()
    window.location.href='/login'
  }

  if(!user) return <div style={{display:'flex', alignItems:'center', justifyContent:'center', minHeight:'100vh'}}>로딩 중...</div>

  return (
    <div style={{minHeight:'100vh', background:'#F5F5F7', fontFamily:'-apple-system, BlinkMacSystemFont, sans-serif'}}>
      <header style={{background:'white', borderBottom:'1px solid #eee', padding:'16px 24px', display:'flex', justifyContent:'space-between', alignItems:'center'}}>
        <div style={{display:'flex', alignItems:'center', gap:'8px'}}>
          <div style={{width:'32px', height:'32px', background:'#FEE500', borderRadius:'8px', display:'flex', alignItems:'center', justifyContent:'center', fontWeight:800}}>C</div>
          <span style={{fontWeight:800}}>카탈로그톡</span>
          <span style={{color:'#999', fontSize:'13px', marginLeft:'12px'}}>{user.email}</span>
        </div>
        <button onClick={handleLogout} style={{border:'1px solid #eee', background:'white', borderRadius:'20px', padding:'6px 14px', fontSize:'13px', cursor:'pointer'}}>로그아웃</button>
      </header>

      <div style={{maxWidth:'900px', margin:'0 auto', padding:'24px'}}>
        <div style={{background:'white', borderRadius:'20px', padding:'24px', marginBottom:'20px', boxShadow:'0 2px 12px rgba(0,0,0,0.04)'}}>
          <h2 style={{fontSize:'18px', fontWeight:700, margin:'0 0 16px'}}>새 카탈로그 업로드</h2>
          <div style={{display:'flex', gap:'12px', flexDirection:'column'}}>
            <input style={{border:'1.5px solid #eee', borderRadius:'12px', padding:'14px', fontSize:'16px', outline:'none'}} placeholder="카탈로그 제목 (예: 2024 쿨오토모빌 카탈로그)" value={title} onChange={e=>setTitle(e.target.value)} />
            <label style={{border:'2px dashed #ddd', borderRadius:'12px', padding:'20px', textAlign:'center', cursor:'pointer', background:'#FAFAFA'}}>
              <div style={{fontSize:'14px', color:'#666'}}>{uploading ? '업로드 중...' : '📄 PDF 파일을 선택하세요 (클릭)'}</div>
              <input type="file" accept=".pdf" onChange={handleUpload} style={{display:'none'}} disabled={uploading} />
            </label>
          </div>
        </div>

        <div style={{background:'white', borderRadius:'20px', padding:'24px', boxShadow:'0 2px 12px rgba(0,0,0,0.04)'}}>
          <h2 style={{fontSize:'18px', fontWeight:700, margin:'0 0 16px'}}>내 플립북 ({flipbooks.length})</h2>
          {flipbooks.length===0 ? (
            <div style={{textAlign:'center', padding:'40px', color:'#999'}}>아직 업로드한 카탈로그가 없어요. 위에서 PDF를 올려보세요!</div>
          ) : (
            <div style={{display:'flex', flexDirection:'column', gap:'12px'}}>
              {flipbooks.map((fb:any)=>(
                <div key={fb.id} style={{border:'1px solid #eee', borderRadius:'12px', padding:'16px', display:'flex', justifyContent:'space-between', alignItems:'center'}}>
                  <div>
                    <div style={{fontWeight:600}}>{fb.title}</div>
                    <div style={{fontSize:'12px', color:'#999', marginTop:'4px'}}>/b/{fb.slug} • 조회수 {fb.views||0}회</div>
                  </div>
                  <div style={{display:'flex', gap:'8px'}}>
                    <a href={`/b/${fb.slug}`} target="_blank" style={{background:'black', color:'white', borderRadius:'8px', padding:'8px 12px', fontSize:'12px', textDecoration:'none'}}>보기</a>
                    <button onClick={()=>{navigator.clipboard.writeText(window.location.origin + '/b/' + fb.slug); alert('링크 복사!')}} style={{border:'1px solid #eee', background:'white', borderRadius:'8px', padding:'8px 12px', fontSize:'12px', cursor:'pointer'}}>복사</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
