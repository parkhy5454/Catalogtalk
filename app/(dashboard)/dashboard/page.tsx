'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import Link from 'next/link'

type Flipbook = {
  id: string
  title: string
  slug: string
  pdf_url: string
  views: number
  created_at: string
}

export default function DashboardPage() {
  const [flipbooks, setFlipbooks] = useState<Flipbook[]>([])
  const [title, setTitle] = useState('')
  const [uploading, setUploading] = useState(false)
  const [user, setUser] = useState<any>(null)
  const [dragOver, setDragOver] = useState(false)
  const supabase = createClient()

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) { window.location.href = '/login'; return }
      setUser(user)
    })
    fetchFlipbooks()
  }, [])

  const fetchFlipbooks = async () => {
    const { data } = await supabase.from('flipbooks').select('*').order('created_at', { ascending: false })
    if (data) setFlipbooks(data)
  }

  const handleFile = async (file: File) => {
    if (!file || !title.trim()) { alert('제목을 입력하고 PDF를 선택하세요'); return }
    if (file.type !== 'application/pdf') { alert('PDF만 업로드 가능합니다'); return }
    if (file.size > 50 * 1024 * 1024) { alert('50MB 이하 파일만 가능합니다'); return }
    setUploading(true)
    try {
      const fileName = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`
      const { error: upErr } = await supabase.storage.from('flipbook-files').upload(fileName, file)
      if (upErr) throw upErr
      const { data: urlData } = supabase.storage.from('flipbook-files').getPublicUrl(fileName)
      const slug = title.toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString().slice(-4)
      const { error } = await supabase.from('flipbooks').insert({ title: title.trim(), slug, pdf_url: urlData.publicUrl, user_id: user?.id })
      if (error) throw error
      setTitle('')
      await fetchFlipbooks()
      alert('✅ 업로드 완료! 링크: /b/' + slug)
    } catch (err: any) {
      alert('오류: ' + err.message)
    }
    setUploading(false)
  }

  const handleLogout = async () => {
    await supabase.auth.signOut()
    window.location.href = '/'
  }

  const totalViews = flipbooks.reduce((s, f) => s + (f.views || 0), 0)

  return (
    <div style={{minHeight:'100vh', background:'#F5F5F0'}}>
      {user?.email === 'parkhy5454@gmail.com' && (
        <div style={{background:'#FEE500', padding:'10px 20px', textAlign:'center', fontSize:'13px', fontWeight:700}}>
          👑 관리자님! <a href="/dashboard/admin" style={{color:'black', textDecoration:'underline', marginLeft:'8px'}}>가입자 관리 보기</a> | <a href="/dashboard/profile" style={{color:'black', textDecoration:'underline', marginLeft:'8px'}}>내 정보</a>
        </div>
      )}
      <header style={{background:'white', borderBottom:'1px solid #eee', padding:'14px 24px', display:'flex', justifyContent:'space-between', alignItems:'center', position:'sticky', top:0, zIndex:10}}>
        <Link href="/" style={{display:'flex', alignItems:'center', gap:'10px', textDecoration:'none', color:'black'}}>
          <div style={{width:'32px', height:'32px', background:'#FEE500', borderRadius:'8px', display:'flex', alignItems:'center', justifyContent:'center', fontWeight:900}}>C</div>
          <span style={{fontWeight:800}}>카탈로그톡</span>
          <span style={{background:'#FEE500', borderRadius:'20px', padding:'3px 10px', fontSize:'11px', fontWeight:700, marginLeft:'8px'}}>BETA</span>
        </Link>
        <div style={{display:'flex', alignItems:'center', gap:'12px'}}>
          <span style={{fontSize:'13px', color:'#666'}}>{user?.email}</span>
          <button onClick={handleLogout} style={{fontSize:'13px', background:'black', color:'white', border:'none', padding:'7px 14px', borderRadius:'20px', cursor:'pointer', fontWeight:600}}>로그아웃</button>
        </div>
      </header>

      <div style={{maxWidth:'900px', margin:'0 auto', padding:'24px 20px 60px'}}>
        <div style={{display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:'12px', marginBottom:'20px'}}>
          <div style={{background:'white', borderRadius:'16px', padding:'18px', boxShadow:'0 2px 8px rgba(0,0,0,0.04)'}}>
            <div style={{fontSize:'12px', color:'#999', fontWeight:600, marginBottom:'6px'}}>내 플립북</div>
            <div style={{fontSize:'24px', fontWeight:800}}>{flipbooks.length}개</div>
          </div>
          <div style={{background:'white', borderRadius:'16px', padding:'18px', boxShadow:'0 2px 8px rgba(0,0,0,0.04)'}}>
            <div style={{fontSize:'12px', color:'#999', fontWeight:600, marginBottom:'6px'}}>총 조회수</div>
            <div style={{fontSize:'24px', fontWeight:800}}>{totalViews.toLocaleString()}회</div>
          </div>
          <div style={{background:'black', borderRadius:'16px', padding:'18px', color:'white'}}>
            <div style={{fontSize:'12px', color:'#aaa', fontWeight:600, marginBottom:'6px'}}>요금제</div>
            <div style={{fontSize:'14px', fontWeight:700}}>무료 플랜 (50개까지)</div>
          </div>
        </div>

        <div style={{background:'white', borderRadius:'20px', padding:'28px', marginBottom:'20px', boxShadow:'0 2px 12px rgba(0,0,0,0.04)'}}>
          <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'20px'}}>
            <h2 style={{fontSize:'18px', fontWeight:800, margin:0}}>새 플립북 만들기</h2>
            <span style={{fontSize:'11px', background:'#FEE500', padding:'4px 10px', borderRadius:'20px', fontWeight:700}}>PDF → 링크 3초</span>
          </div>
          <div style={{display:'flex', flexDirection:'column', gap:'14px'}}>
            <div>
              <label style={{fontSize:'12px', fontWeight:600, color:'#666', marginBottom:'6px', display:'block'}}>카탈로그 제목</label>
              <input value={title} onChange={e=>setTitle(e.target.value)} placeholder="예: 2024 쿨오토모빌 카탈로그" style={{width:'100%', border:'1.5px solid #eee', borderRadius:'12px', padding:'14px 16px', fontSize:'16px', outline:'none'}} />
            </div>
            <div
              onDragOver={(e)=>{e.preventDefault(); setDragOver(true)}}
              onDragLeave={()=>setDragOver(false)}
              onDrop={(e)=>{e.preventDefault(); setDragOver(false); const f=e.dataTransfer.files[0]; if(f) handleFile(f)}}
              style={{border:`2px dashed ${dragOver ? '#FEE500' : '#ddd'}`, borderRadius:'16px', padding:'32px 20px', textAlign:'center', cursor:'pointer', background: dragOver ? '#FFFEF0' : '#FAFAFA'}}
            >
              <div style={{fontSize:'36px', marginBottom:'10px'}}>{uploading ? '⏳' : '📄'}</div>
              <div style={{fontSize:'14px', fontWeight:600, marginBottom:'6px'}}>{uploading ? '업로드 중...' : 'PDF를 여기에 드래그하거나 클릭하세요'}</div>
              <div style={{fontSize:'12px', color:'#999', marginBottom:'14px'}}>최대 50MB, 카톡에서 바로 보이는 플립북으로 변환</div>
              <label style={{background:'black', color:'white', borderRadius:'10px', padding:'10px 20px', fontSize:'13px', fontWeight:700, cursor:'pointer', display:'inline-block'}}>
                파일 선택
                <input type="file" accept=".pdf" onChange={e=>{const f=e.target.files?.[0]; if(f) handleFile(f)}} style={{display:'none'}} disabled={uploading} />
              </label>
            </div>
          </div>
        </div>

        <div style={{background:'white', borderRadius:'20px', padding:'28px', boxShadow:'0 2px 12px rgba(0,0,0,0.04)'}}>
          <h2 style={{fontSize:'18px', fontWeight:800, margin:'0 0 16px'}}>내 플립북 ({flipbooks.length})</h2>
          {flipbooks.length===0 ? (
            <div style={{textAlign:'center', padding:'50px 20px', color:'#999'}}>
              <div style={{fontSize:'40px', marginBottom:'12px'}}>📚</div>
              <div style={{fontSize:'14px', fontWeight:600, marginBottom:'6px'}}>아직 만든 플립북이 없어요</div>
              <div style={{fontSize:'12px'}}>위에서 PDF를 올리면 카톡 링크가 바로 생겨요!</div>
            </div>
          ) : (
            <div style={{display:'flex', flexDirection:'column', gap:'10px'}}>
              {flipbooks.map((fb)=>(
                <div key={fb.id} style={{border:'1px solid #f0f0f0', borderRadius:'14px', padding:'16px', display:'flex', justifyContent:'space-between', alignItems:'center', gap:'12px'}}>
                  <div style={{flex:1, minWidth:0}}>
                    <div style={{fontWeight:700, fontSize:'14px', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>{fb.title}</div>
                    <div style={{fontSize:'11px', color:'#999', marginTop:'4px', display:'flex', gap:'8px', alignItems:'center'}}>
                      <span>/b/{fb.slug}</span>
                      <span style={{background:'#F5F5F5', borderRadius:'10px', padding:'2px 8px'}}>조회 {fb.views||0}회</span>
                      <span>{new Date(fb.created_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <div style={{display:'flex', gap:'6px', flexShrink:0}}>
                    <Link href={`/b/${fb.slug}`} target="_blank" style={{background:'black', color:'white', borderRadius:'10px', padding:'8px 14px', fontSize:'12px', textDecoration:'none', fontWeight:600}}>보기</Link>
                    <button onClick={()=>{navigator.clipboard.writeText(window.location.origin + '/b/' + fb.slug); alert('✅ 링크 복사!')}} style={{border:'1px solid #eee', background:'white', borderRadius:'10px', padding:'8px 12px', fontSize:'12px', cursor:'pointer', fontWeight:600}}>복사</button>
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