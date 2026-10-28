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
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setLoading(false)
    if(error) alert(error.message)
    else router.push('/dashboard')
  }

  const handleMagicLink = async () => {
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin + '/dashboard' } })
    if(error) alert(error.message)
    else alert('이메일을 확인하세요! 로그인 링크를 보냈어요.')
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F5F5F7] p-4">
      <div className="bg-white rounded-[24px] p-8 w-full max-w-[400px] shadow-sm">
        <h1 className="text-2xl font-bold mb-2">로그인</h1>
        <p className="text-gray-500 text-sm mb-6">카탈로그톡 대시보드</p>
        <form onSubmit={handleLogin} className="space-y-4">
          <input className="w-full border rounded-xl px-4 py-3 text-[16px]" placeholder="이메일" type="email" value={email} onChange={e=>setEmail(e.target.value)} required />
          <input className="w-full border rounded-xl px-4 py-3 text-[16px]" placeholder="비밀번호" type="password" value={password} onChange={e=>setPassword(e.target.value)} required />
          <button disabled={loading} className="w-full bg-black text-white rounded-xl py-3 font-semibold">{loading?'로그인 중...':'로그인'}</button>
        </form>
        <button onClick={handleMagicLink} className="w-full mt-3 border rounded-xl py-3 text-sm">✉️ 이메일 링크로 로그인 (비밀번호 없이)</button>
        <p className="text-center text-sm mt-6 text-gray-500">계정이 없나요? <a href="/signup" className="text-black font-semibold underline">회원가입</a></p>
        <p className="text-center text-sm mt-2"><a href="/" className="text-gray-400">← 홈으로</a></p>
      </div>
    </div>
  )
}
