'use client'
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

export default function SignupPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [company, setCompany] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const router = useRouter()
  const supabase = createClient()

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { company_name: company } }
    })
    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }
    if (data.user) {
      try {
        await supabase.from('customers').insert({ email, company_name: company, user_id: data.user.id })
      } catch {}
    }
    router.push('/dashboard')
  }

  return (
    <div style={{minHeight:'100vh', display:'flex', background:'#FEE500'}}>
      <div style={{flex:1, display:'flex', alignItems:'center', justifyContent:'center', padding:'24px'}}>
        <div style={{background:'white', borderRadius:'24px', padding:'36px 28px', width:'100%', maxWidth:'380px', boxShadow:'0 20px 60px rgba(0,0,0,0.15)'}}>
          <div style={{textAlign:'center', marginBottom:'28px'}}>
            <div style={{display:'inline-flex', alignItems:'center', gap:'6px', background:'black', color:'white', borderRadius:'20px', padding:'6px 12px', fontSize:'11px', fontWeight:700, marginBottom:'12px'}}>
              <span style={{width:'6px', height:'6px', background:'#4ade80', borderRadius:'50%', display:'inline-block'}}></span>
              지금 가입하면 첫 달 무료
            </div>
            <h1 style={{fontSize:'24px', fontWeight:900, margin:'0 0 6px', lineHeight:'1.2'}}>카탈로그를<br/>카톡처럼 보내세요</h1>
            <p style={{color:'#888', fontSize:'13px', margin:0}}>PDF를 올리면 3초 만에 플립북 링크 완성</p>
          </div>

          {error && <div style={{background:'#fee', border:'1px solid #fcc', borderRadius:'10px', padding:'10px 12px', fontSize:'13px', color:'#c00', marginBottom:'16px'}}>{error}</div>}

          <form onSubmit={handleSignup} style={{display:'flex', flexDirection:'column', gap:'10px'}}>
            <input value={company} onChange={e=>setCompany(e.target.value)} placeholder="회사명 (선택)" style={{width:'100%', border:'1.5px solid #eee', borderRadius:'12px', padding:'14px 16px', fontSize:'16px', outline:'none'}} />
            <input value={email} onChange={e=>setEmail(e.target.value)} placeholder="업무용 이메일" type="email" required style={{width:'100%', border:'1.5px solid #eee', borderRadius:'12px', padding:'14px 16px', fontSize:'16px', outline:'none'}} />
            <input value={password} onChange={e=>setPassword(e.target.value)} placeholder="비밀번호 (6자 이상)" type="password" required minLength={6} style={{width:'100%', border:'1.5px solid #eee', borderRadius:'12px', padding:'14px 16px', fontSize:'16px', outline:'none'}} />
            <button disabled={loading} type="submit" style={{width:'100%', background:'black', color:'white', borderRadius:'12px', padding:'14px', fontWeight:700, fontSize:'15px', border:'none', cursor:'pointer', marginTop:'8px'}}>{loading ? '가입 중...' : '무료로 시작하기'}</button>
          </form>

          <div style={{textAlign:'center', marginTop:'22px', fontSize:'14px', color:'#666'}}>
            이미 계정이 있나요? <Link href="/login" style={{color:'black', fontWeight:800}}>로그인</Link>
          </div>
        </div>
      </div>
    </div>
  )
}