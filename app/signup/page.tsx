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
    const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { company_name: company } } })
    if(error){ alert(error.message); setLoading(false); return; }
    // customers 테이블에도 저장
    if(data.user){
      await supabase.from('customers').insert({ email, company_name: company })
    }
    setLoading(false)
    alert('회원가입 완료! 이메일을 확인하고 인증해주세요. (바로 로그인될 수도 있어요)')
    router.push('/dashboard')
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F5F5F7] p-4">
      <div className="bg-white rounded-[24px] p-8 w-full max-w-[400px] shadow-sm">
        <h1 className="text-2xl font-bold mb-2">회원가입</h1>
        <p className="text-gray-500 text-sm mb-6">카탈로그톡 무료로 시작하기</p>
        <form onSubmit={handleSignup} className="space-y-4">
          <input className="w-full border rounded-xl px-4 py-3 text-[16px]" placeholder="회사명 (선택)" value={company} onChange={e=>setCompany(e.target.value)} />
          <input className="w-full border rounded-xl px-4 py-3 text-[16px]" placeholder="이메일" type="email" value={email} onChange={e=>setEmail(e.target.value)} required />
          <input className="w-full border rounded-xl px-4 py-3 text-[16px]" placeholder="비밀번호 (6자 이상)" type="password" value={password} onChange={e=>setPassword(e.target.value)} required minLength={6} />
          <button disabled={loading} className="w-full bg-black text-white rounded-xl py-3 font-semibold">{loading?'가입 중...':'무료로 시작하기'}</button>
        </form>
        <p className="text-center text-sm mt-6 text-gray-500">이미 계정이 있나요? <a href="/login" className="text-black font-semibold underline">로그인</a></p>
      </div>
    </div>
  )
}
