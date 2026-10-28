'use client'
export const dynamic = 'force-dynamic'
import { useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useRouter } from 'next/navigation'

export default function Login(){
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  const handleLogin = async (e:any) => {
    e.preventDefault()
    setLoading(true)
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    setLoading(false)
    if(error){ alert('로그인 실패: ' + error.message); return; }
    if(data.user){ router.push('/dashboard') }
  }

  const handleMagic = async () => {
    if(!email){ alert('이메일을 먼저 입력하세요'); return; }
    setLoading(true)
    const { error } = await supabase.auth.signInWithOtp({ email, options:{ emailRedirectTo: window.location.origin + '/dashboard' } })
    setLoading(false)
    if(error) alert(error.message)
    else alert('✉️ 이메일로 로그인 링크를 보냈어요! 메일함을 확인하세요.')
  }

  return (
    <div style={{minHeight:'100vh', display:'flex', flexDirection:'column', background:'#FEE500', fontFamily:'-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif'}}>
      <div style={{padding:'20px 24px', display:'flex', justifyContent:'space-between', alignItems:'center'}}>
        <a href="/" style={{display:'flex', alignItems:'center', gap:'8px', textDecoration:'none', color:'black'}}>
          <div style={{width:'32px', height:'32px', background:'black', borderRadius:'8px', display:'flex', alignItems:'center', justifyContent:'center', color:'white', fontWeight:900, fontSize:'14px'}}>C</div>
          <span style={{fontWeight:800, fontSize:'16px'}}>카탈로그톡</span>
        </a>
        <a href="/" style={{fontSize:'13px', color:'#000', opacity:0.6, textDecoration:'none'}}>← 홈으로</a>
      </div>

      <div style={{flex:1, display:'flex', alignItems:'center', justifyContent:'center', padding:'20px 20px 60px'}}>
        <div style={{background:'white', borderRadius:'24px', padding:'36px 28px', width:'100%', maxWidth:'380px', boxShadow:'0 20px 60px rgba(0,0,0,0.15)'}}>
          <div style={{textAlign:'center', marginBottom:'28px'}}>
            <div style={{width:'56px', height:'56px', background:'#000', borderRadius:'16px', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 14px', fontSize:'28px'}}>📖</div>
            <h1 style={{fontSize:'26px', fontWeight:900, margin:'0 0 6px', letterSpacing:'-0.5px'}}>로그인</h1>
            <p style={{color:'#888', fontSize:'14px', margin:0}}>카탈로그톡 대시보드</p>
          </div>

          <form onSubmit={handleLogin} style={{display:'flex', flexDirection:'column', gap:'10px'}}>
            <input value={email} onChange={e=>setEmail(e.target.value)} placeholder="이메일 주소" type="email" required style={{width:'100%', border:'1.5px solid #eee', borderRadius:'12px', padding:'14px 16px', fontSize:'16px', outline:'none', boxSizing:'border-box'}} />
            <input value={password} onChange={e=>setPassword(e.target.value)} placeholder="비밀번호" type="password" required style={{width:'100%', border:'1.5px solid #eee', borderRadius:'12px', padding:'14px 16px', fontSize:'16px', outline:'none', boxSizing:'border-box'}} />
            <button disabled={loading} type="submit" style={{width:'100%', background:'black', color:'white', borderRadius:'12px', padding:'14px', fontWeight:700, fontSize:'15px', border:'none', cursor:'pointer', marginTop:'8px', opacity:loading?0.6:1}}>{loading?'로그인 중...':'로그인'}</button>
          </form>

          <button onClick={handleMagic} style={{width:'100%', marginTop:'10px', border:'1.5px solid #eee', background:'white', borderRadius:'12px', padding:'13px', fontSize:'13px', cursor:'pointer', fontWeight:600}}>✉️ 이메일 링크로 로그인 (비밀번호 없이)</button>

          <div style={{textAlign:'center', marginTop:'22px', fontSize:'14px', color:'#666'}}>
            계정이 없나요? <a href="/signup" style={{color:'black', fontWeight:800, textDecoration:'underline'}}>회원가입</a>
          </div>
        </div>
      </div>
    </div>
  )
}
