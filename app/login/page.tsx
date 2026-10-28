'use client'
export const dynamic = 'force-dynamic'
import { useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useRouter } from 'next/navigation'

export default function Login(){
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<'password'|'magic'>('password')
  const router = useRouter()

  const handleLogin = async (e:any) => {
    e.preventDefault()
    setLoading(true)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setLoading(false)
    if(error) alert(error.message)
    else router.push('/dashboard')
  }

  const handleMagic = async (e:any) => {
    e.preventDefault()
    setLoading(true)
    const { error } = await supabase.auth.signInWithOtp({ 
      email, 
      options: { emailRedirectTo: typeof window !== 'undefined' ? window.location.origin + '/dashboard' : undefined } 
    })
    setLoading(false)
    if(error) alert(error.message)
    else alert('📧 이메일을 확인하세요! 로그인 링크를 보냈어요.')
  }

  return (
    <div className="min-h-screen bg-[#FFFBEB] flex flex-col">
      {/* Header */}
      <header className="p-6 flex justify-between items-center">
        <a href="/" className="flex items-center gap-2">
          <div className="w-8 h-8 bg-[#FEE500] rounded-full flex items-center justify-center text-[16px] font-bold">C</div>
          <span className="font-bold text-[15px]">카탈로그톡</span>
        </a>
        <a href="/" className="text-sm text-gray-400">← 홈으로</a>
      </header>

      <div className="flex-1 flex items-center justify-center p-4 pb-20">
        <div className="w-full max-w-[440px]">
          {/* Bubble */}
          <div className="text-center mb-8">
            <div className="inline-block bg-white border border-black/[0.06] shadow-[0_8px_24px_rgba(0,0,0,0.06)] rounded-[24px] rounded-bl-[8px] px-6 py-4 mb-4">
              <p className="text-[14px] font-medium">다시 오셨군요! 👋</p>
              <p className="text-[13px] text-gray-500 mt-1">카탈로그를 카톡처럼 쉽게</p>
            </div>
            <h1 className="text-[28px] font-extrabold tracking-tight">로그인</h1>
            <p className="text-[14px] text-gray-500 mt-2">계정에 로그인하고 플립북을 관리하세요</p>
          </div>

          <div className="bg-white rounded-[28px] p-7 shadow-[0_16px_48px_rgba(0,0,0,0.08)] border border-black/[0.04]">
            {/* Tabs */}
            <div className="flex bg-[#F5F5F7] rounded-full p-1 mb-6">
              <button onClick={()=>setMode('password')} className={`flex-1 py-2.5 rounded-full text-[14px] font-semibold transition-all ${mode==='password' ? 'bg-black text-white shadow' : 'text-gray-500'}`}>비밀번호로</button>
              <button onClick={()=>setMode('magic')} className={`flex-1 py-2.5 rounded-full text-[14px] font-semibold transition-all ${mode==='magic' ? 'bg-black text-white shadow' : 'text-gray-500'}`}>이메일 링크로</button>
            </div>

            {mode==='password' ? (
              <form onSubmit={handleLogin} className="space-y-4">
                <div>
                  <label className="text-[12px] font-semibold text-gray-500 ml-1">이메일</label>
                  <input className="mt-1.5 w-full bg-[#F9F9FB] border border-transparent focus:bg-white focus:border-black rounded-[14px] px-4 py-3.5 text-[16px] outline-none transition-all" placeholder="company@catalogtalk.kr" type="email" value={email} onChange={e=>setEmail(e.target.value)} required />
                </div>
                <div>
                  <label className="text-[12px] font-semibold text-gray-500 ml-1">비밀번호</label>
                  <input className="mt-1.5 w-full bg-[#F9F9FB] border border-transparent focus:bg-white focus:border-black rounded-[14px] px-4 py-3.5 text-[16px] outline-none transition-all" placeholder="••••••••" type="password" value={password} onChange={e=>setPassword(e.target.value)} required />
                </div>
                <button disabled={loading} className="w-full bg-black text-white rounded-[14px] py-4 font-bold text-[15px] mt-2 active:scale-[0.98] transition-transform disabled:opacity-50">
                  {loading ? '로그인 중...' : '로그인 →'}
                </button>
              </form>
            ) : (
              <form onSubmit={handleMagic} className="space-y-4">
                <div>
                  <label className="text-[12px] font-semibold text-gray-500 ml-1">이메일</label>
                  <input className="mt-1.5 w-full bg-[#F9F9FB] border border-transparent focus:bg-white focus:border-black rounded-[14px] px-4 py-3.5 text-[16px] outline-none transition-all" placeholder="company@catalogtalk.kr" type="email" value={email} onChange={e=>setEmail(e.target.value)} required />
                  <p className="text-[11px] text-gray-400 mt-2 ml-1">비밀번호 없이 이메일로 바로 로그인할 수 있어요</p>
                </div>
                <button disabled={loading} className="w-full bg-[#FEE500] text-black rounded-[14px] py-4 font-bold text-[15px] mt-2 active:scale-[0.98] transition-transform disabled:opacity-50">
                  {loading ? '보내는 중...' : '✉️ 로그인 링크 보내기'}
                </button>
              </form>
            )}

            <div className="mt-6 pt-6 border-t border-black/[0.06] flex justify-between text-[13px]">
              <a href="/signup" className="text-gray-500">계정이 없나요? <span className="text-black font-bold underline">회원가입</span></a>
              <a href="#" onClick={(e)=>{e.preventDefault(); alert('비밀번호 찾기는 Supabase 대시보드 > Auth > Email Templates에서 설정할 수 있어요. 지금은 매직링크로 로그인하세요!')}} className="text-gray-400">비밀번호 찾기</a>
            </div>
          </div>

          <p className="text-center text-[11px] text-gray-400 mt-6">로그인하면 <a className="underline">이용약관</a>과 <a className="underline">개인정보처리방침</a>에 동의하는 것으로 간주됩니다.</p>
        </div>
      </div>
    </div>
  )
}
