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
    const { data, error } = await supabase.auth.signUp({ 
      email, 
      password,
      options: { data: { company_name: company } }
    })
    if(error){ alert(error.message); setLoading(false); return; }
    if(data.user){
      await supabase.from('customers').insert({ email, company_name: company })
    }
    setLoading(false)
    alert('🎉 가입 완료! 이메일 인증 후 바로 시작할 수 있어요. (설정에 따라 바로 로그인됩니다)')
    router.push('/dashboard')
  }

  return (
    <div className="min-h-screen bg-[#FFFBEB] flex flex-col">
      <header className="p-6 flex justify-between items-center">
        <a href="/" className="flex items-center gap-2">
          <div className="w-8 h-8 bg-[#FEE500] rounded-full flex items-center justify-center text-[16px] font-bold">C</div>
          <span className="font-bold text-[15px]">카탈로그톡</span>
        </a>
        <a href="/login" className="text-sm bg-white border rounded-full px-4 py-2 font-semibold">로그인</a>
      </header>

      <div className="flex-1 flex items-center justify-center p-4 pb-20">
        <div className="w-full max-w-[440px]">
          <div className="text-center mb-8">
            <div className="inline-flex items-center gap-2 bg-black text-white rounded-full px-4 py-1.5 text-[11px] font-bold mb-4">
              <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></span>
              지금 가입하면 첫 달 무료
            </div>
            <h1 className="text-[28px] font-extrabold tracking-tight leading-[1.1]">카탈로그를<br/>카톡처럼 보내세요</h1>
            <p className="text-[14px] text-gray-500 mt-3">PDF를 올리면 3초 만에 플립북 링크 완성</p>
          </div>

          <div className="bg-white rounded-[28px] p-7 shadow-[0_16px_48px_rgba(0,0,0,0.08)] border border-black/[0.04]">
            <form onSubmit={handleSignup} className="space-y-4">
              <div>
                <label className="text-[12px] font-semibold text-gray-500 ml-1">회사명</label>
                <input className="mt-1.5 w-full bg-[#F9F9FB] border border-transparent focus:bg-white focus:border-black rounded-[14px] px-4 py-3.5 text-[16px] outline-none transition-all" placeholder="예) 쿨오토모빌" value={company} onChange={e=>setCompany(e.target.value)} />
              </div>
              <div>
                <label className="text-[12px] font-semibold text-gray-500 ml-1">업무용 이메일</label>
                <input className="mt-1.5 w-full bg-[#F9F9FB] border border-transparent focus:bg-white focus:border-black rounded-[14px] px-4 py-3.5 text-[16px] outline-none transition-all" placeholder="company@catalogtalk.kr" type="email" value={email} onChange={e=>setEmail(e.target.value)} required />
              </div>
              <div>
                <label className="text-[12px] font-semibold text-gray-500 ml-1">비밀번호</label>
                <input className="mt-1.5 w-full bg-[#F9F9FB] border border-transparent focus:bg-white focus:border-black rounded-[14px] px-4 py-3.5 text-[16px] outline-none transition-all" placeholder="6자 이상" type="password" value={password} onChange={e=>setPassword(e.target.value)} required minLength={6} />
                <p className="text-[11px] text-gray-400 mt-2 ml-1">영문, 숫자 조합으로 6자 이상</p>
              </div>
              <button disabled={loading} className="w-full bg-black text-white rounded-[14px] py-4 font-bold text-[15px] mt-2 active:scale-[0.98] transition-transform disabled:opacity-50">
                {loading ? '계정 만드는 중...' : '무료로 시작하기 →'}
              </button>
            </form>

            <div className="mt-6">
              <div className="flex items-center gap-3 text-[11px] text-gray-400 justify-center">
                <span className="h-px bg-black/10 flex-1"></span>
                <span>이미 23개 회사가 사용 중</span>
                <span className="h-px bg-black/10 flex-1"></span>
              </div>
            </div>

            <div className="mt-6 pt-6 border-t border-black/[0.06] text-center text-[13px] text-gray-500">
              이미 계정이 있나요? <a href="/login" className="text-black font-bold underline">로그인</a>
            </div>
          </div>

          <div className="mt-6 grid grid-cols-3 gap-3 text-center">
            <div className="bg-white/70 rounded-2xl py-3">
              <div className="text-[18px]">⚡️</div>
              <div className="text-[11px] font-semibold mt-1">3초 변환</div>
            </div>
            <div className="bg-white/70 rounded-2xl py-3">
              <div className="text-[18px]">📊</div>
              <div className="text-[11px] font-semibold mt-1">조회수 추적</div>
            </div>
            <div className="bg-white/70 rounded-2xl py-3">
              <div className="text-[18px]">💬</div>
              <div className="text-[11px] font-semibold mt-1">카톡 공유</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
