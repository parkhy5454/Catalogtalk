'use client'
export const dynamic = 'force-dynamic'
import { useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useRouter } from 'next/navigation'

export default function Signup(){
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [company, setCompany] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  const handleSignup = async (e:any) => {
    e.preventDefault()
    setLoading(true)
    const { data, error } = await supabase.auth.signUp({ email, password, options:{ data:{ company_name: company } } })
    if(error){ alert(error.message); setLoading(false); return; }
    if(data.user){
      try{ await supabase.from('customers').insert({ email, company_name: company }) }catch{}
    }
    setLoading(false)
    alert('🎉 회원가입 완료!')
    router.push('/dashboard')
  }

  return (
    <div style={{minHeight:'100vh', display:'flex', flexDirection:'column', background:'#FEE500', fontFamily:'-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif'}}>
      <div style={{padding:'20px 24px', display:'flex', justifyContent:'space-between', alignItems:'center'}}>
        <a href="/" style={{display:'flex', alignItems:'center', gap:'8px', textDecoration:'none', color:'black'}}>
          <div style={{width:'32px', height:'32px', background:'black', borderRadius:'8px', display:'flex', alignItems:'center', justifyContent:'center', color:'white', fontWeight:900, fontSize:'14px'}}>C</div>
          <span style={{fontWeight:800, fontSize:'16px'}}>카탈로그톡</span>
        </a>
        <a href="/login" style={{fontSize:'13px', background:'white', borderRadius:'20px', padding:'7px 14px', textDecoration:'none', color:'black', fontWeight:700}}>로그인</a>
      </div>

      <div style={{flex:1, display:'flex', alignItems:'center', justifyContent:'center', padding:'20px 20px 60px'}}>
        <div style={{background:'white', borderRadius:'24px', padding:'36px 28px', width:'100%', maxWidth:'380px', boxShadow:'0 20px 60px rgba(0,0,0,0.15)'}}>
          <div style={{textAlign:'center', marginBottom:'28px'}}>
            <div style={{display:'inline-flex', alignItems:'center', gap:'6px', background:'black', color:'white', borderRadius:'20px', padding:'6px 12px', fontSize:'11px', fontWeight:700, marginBottom:'12px'}}>
              <span style={{width:'6px', height:'6px', background:'#4ade80', borderRadius:'50%', display:'inline-block'}}></span>
              지금 가입하면 첫 달 무료
            </div>
            <h1 style={{fontSize:'24px', fontWeight:900, margin:'0 0 6px', letterSpacing:'-0.5px', lineHeight:'1.2'}}>카탈로그를<br/>카톡처럼 보내세요</h1>
            <p style={{color:'#888', fontSize:'13px', margin:0}}>PDF를 올리면 3초 만에 플립북 링크 완성</p>
          </div>

          <form onSubmit={handleSignup} style={{display:'flex', flexDirection:'column', gap:'10px'}}>
            <input value={company} onChange={e=>setCompany(e.target.value)} placeholder="회사명 (선택)" style={{width:'100%', border:'1.5px solid #eee', borderRadius:'12px', padding:'14px 16px', fontSize:'16px', outline:'none', boxSizing:'border-box'}} />
            <input value={email} onChange={e=>setEmail(e.target.value)} placeholder="업무용 이메일" type="email" required style={{width:'100%', border:'1.5px solid #eee', borderRadius:'12px', padding:'14px 16px', fontSize:'16px', outline:'none', boxSizing:'border-box'}} />
            <input value={password} onChange={e=>setPassword(e.target.value)} placeholder="비밀번호 (6자 이상)" type="password" required minLength={6} style={{width:'100%', border:'1.5px solid #eee', borderRadius:'12px', padding:'14px 16px', fontSize:'16px', outline:'none', boxSizing:'border-box'}} />
            <button disabled={loading} type="submit" style={{width:'100%', background:'black', color:'white', borderRadius:'12px', padding:'14px', fontWeight:700, fontSize:'15px', border:'none', cursor:'pointer', marginTop:'8px', opacity:loading?0.6:1}}>{loading?'가입 중...':'무료로 시작하기'}</button>
          </form>

          <div style={{textAlign:'center', marginTop:'22px', fontSize:'14px', color:'#666'}}>
            이미 계정이 있나요? <a href="/login" style={{color:'black', fontWeight:800, textDecoration:'underline'}}>로그인</a>
          </div>
        </div>
      </div>
    </div>
  )
}
