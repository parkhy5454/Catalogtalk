'use client'
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const router = useRouter()
  const supabase = createClient()

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      router.push('/dashboard')
    }
  }

  const handleMagicLink = async () => {
    if (!email) { setError('이메일을 입력하세요'); return }
    setLoading(true)
    setError('')
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/dashboard` }
    })
    setLoading(false)
    if (error) setError(error.message)
    else alert('📧 이메일로 로그인 링크를 보냈어요!')
  }

  return (
    <div style={{minHeight:'100vh', display:'flex', background:'#FEE500'}}>
      <div style={{flex:1, display:'flex', alignItems:'center', justifyContent:'center', padding:'24px'}}>
        <div style={{background:'white', borderRadius:'24px', padding:'36px 28px', width:'100%', maxWidth:'380px', boxShadow:'0 20px 60px rgba(0,0,0,0.15)'}}>
          <div style={{textAlign:'center', marginBottom:'28px'}}>
            <div style={{width:'56px', height:'56px', background:'black', borderRadius:'16px', display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 14px', fontSize:'28px'}}>📖</div>
            <h1 style={{fontSize:'26px', fontWeight:900, margin:'0 0 6px'}}>로그인</h1>
            <p style={{color:'#888', fontSize:'14px', margin:0}}>카탈로그톡 대시보드</p>
          </div>

          {error && <div style={{background:'#fee', border:'1px solid #fcc', borderRadius:'10px', padding:'10px 12px', fontSize:'13px', color:'#c00', marginBottom:'16px'}}>{error}</div>}

          <form onSubmit={handleLogin} style={{display:'flex', flexDirection:'column', gap:'10px'}}>
            <input value={email} onChange={e=>setEmail(e.target.value)} placeholder="이메일 주소" type="email" required style={{width:'100%', border:'1.5px solid #eee', borderRadius:'12px', padding:'14px 16px', fontSize:'16px', outline:'none'}} />
            <input value={password} onChange={e=>setPassword(e.target.value)} placeholder="비밀번호" type="password" required style={{width:'100%', border:'1.5px solid #eee', borderRadius:'12px', padding:'14px 16px', fontSize:'16px', outline:'none'}} />
            <button disabled={loading} type="submit" style={{width:'100%', background:'black', color:'white', borderRadius:'12px', padding:'14px', fontWeight:700, fontSize:'15px', border:'none', cursor:'pointer', marginTop:'8px'}}>{loading ? '로그인 중...' : '로그인'}</button>
          </form>

          <button onClick={handleMagicLink} disabled={loading} style={{width:'100%', marginTop:'10px', border:'1.5px solid #eee', background:'white', borderRadius:'12px', padding:'13px', fontSize:'13px', cursor:'pointer', fontWeight:600}}>✉️ 이메일 링크로 로그인</button>

          <div style={{textAlign:'center', marginTop:'22px', fontSize:'14px', color:'#666'}}>
            계정이 없나요? <Link href="/signup" style={{color:'black', fontWeight:800}}>회원가입</Link>
          </div>
          <div style={{textAlign:'center', marginTop:'10px'}}>
            <Link href="/" style={{color:'#aaa', fontSize:'13px', textDecoration:'none'}}>← 홈으로</Link>
          </div>
        </div>
      </div>
    </div>
  )
}