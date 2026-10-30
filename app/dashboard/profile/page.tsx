'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { scrollIntoViewOnFocus } from '@/lib/ui'
import { formatPhone } from '@/lib/phone'

type Msg = { ok: boolean; text: string } | null


export default function ProfilePage() {
  const [email, setEmail] = useState('')
  const [createdAt, setCreatedAt] = useState('')
  const [userId, setUserId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [company, setCompany] = useState('')
  const [savingInfo, setSavingInfo] = useState(false)
  const [infoMsg, setInfoMsg] = useState<Msg>(null)
  const [newPassword, setNewPassword] = useState('')
  const [savingPw, setSavingPw] = useState(false)
  const [pwMsg, setPwMsg] = useState<Msg>(null)
  const router = useRouter()
  const supabase = createClient()

  useEffect(() => {
    ;(async () => {
      const { data } = await supabase.auth.getUser()
      const user = data.user
      if (!user) {
        router.replace('/login')
        return
      }
      setEmail(user.email ?? '')
      setCreatedAt(user.created_at ?? '')
      setUserId(user.id)
      const { data: customer } = await supabase
        .from('customers')
        .select('name, phone, company_name')
        .eq('user_id', user.id)
        .maybeSingle()
      setName(customer?.name ?? '')
      setPhone(customer?.phone ?? '')
      setCompany(customer?.company_name ?? '')
    })()
    // supabase is stable for the lifetime of the page
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const saveInfo = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!userId) return
    const cleanPhone = phone.trim()
    if (cleanPhone && !/^[0-9+()\-\s]{7,20}$/.test(cleanPhone)) {
      setInfoMsg({ ok: false, text: '전화번호는 숫자, +, -, 괄호만 입력해 주세요' })
      return
    }
    setSavingInfo(true)
    setInfoMsg(null)
    // RLS plus the column grant in schema.sql limit this update to name, phone and company.
    // .select() returns the updated rows: an update that matched nothing is not a success.
    const { data: updated, error } = await supabase
      .from('customers')
      .update({
        name: name.trim() || null,
        phone: cleanPhone || null,
        company_name: company.trim() || null,
      })
      .eq('user_id', userId)
      .select('user_id')
    setSavingInfo(false)
    if (error) setInfoMsg({ ok: false, text: '저장하지 못했어요: ' + error.message })
    else if (!updated || updated.length === 0)
      setInfoMsg({ ok: false, text: '저장되지 않았어요. 고객 정보가 없는 계정일 수 있어요. 관리자에게 알려 주세요.' })
    else setInfoMsg({ ok: true, text: '✅ 내 정보를 저장했어요' })
  }

  const updatePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (newPassword.length < 6) {
      setPwMsg({ ok: false, text: '비밀번호는 6자 이상이어야 해요' })
      return
    }
    setSavingPw(true)
    setPwMsg(null)
    const { error } = await supabase.auth.updateUser({ password: newPassword })
    setSavingPw(false)
    if (error) setPwMsg({ ok: false, text: '오류: ' + error.message })
    else {
      setPwMsg({ ok: true, text: '✅ 비밀번호가 변경되었어요!' })
      setNewPassword('')
    }
  }

  return (
    <main className="container section">
        <div className="panel profile-card">
          <h1 className="panel-title" style={{ marginBottom: 20 }}>내 정보</h1>

          <div className="info-box">
            <div className="info-label">이메일</div>
            <div className="info-value">{email || '-'}</div>
            <div className="info-label" style={{ marginTop: 10 }}>가입일</div>
            <div className="info-value" style={{ fontWeight: 500 }}>
              {createdAt ? new Date(createdAt).toLocaleDateString('ko-KR') : '-'}
            </div>
          </div>

          <form onSubmit={saveInfo} className="form-stack" style={{ marginTop: 20 }}>
            <label className="field">
              <span className="field-label">이름</span>
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onFocus={scrollIntoViewOnFocus}
                placeholder="이름"
                autoComplete="name"
                maxLength={50}
              />
            </label>
            <label className="field">
              <span className="field-label">휴대폰 번호</span>
              <input
                className="input"
                value={phone}
                onChange={(e) => setPhone(formatPhone(e.target.value))}
                onFocus={scrollIntoViewOnFocus}
                placeholder="010-0000-0000"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                maxLength={20}
              />
            </label>
            <label className="field">
              <span className="field-label">회사명</span>
              <input
                className="input"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                onFocus={scrollIntoViewOnFocus}
                placeholder="회사명"
                autoComplete="organization"
                maxLength={100}
              />
            </label>
            <button type="submit" disabled={savingInfo || !userId} className="btn btn-primary btn-block">
              {savingInfo ? '저장 중...' : '내 정보 저장'}
            </button>
          </form>

          {infoMsg && (
            <div className={`notice ${infoMsg.ok ? 'notice-success' : 'notice-error'}`} role="status" style={{ marginTop: 16 }}>
              {infoMsg.text}
            </div>
          )}

          <form onSubmit={updatePassword} className="form-stack" style={{ marginTop: 28 }}>
            <label className="field">
              <span className="field-label">새 비밀번호</span>
              <input
                className="input"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                onFocus={scrollIntoViewOnFocus}
                placeholder="6자 이상 입력"
                autoComplete="new-password"
                minLength={6}
              />
            </label>
            <button type="submit" disabled={savingPw} className="btn btn-primary btn-block">
              {savingPw ? '변경 중...' : '비밀번호 변경'}
            </button>
          </form>

          {pwMsg && (
            <div className={`notice ${pwMsg.ok ? 'notice-success' : 'notice-error'}`} role="status" style={{ marginTop: 16 }}>
              {pwMsg.text}
            </div>
          )}

        </div>
    </main>
  )
}
