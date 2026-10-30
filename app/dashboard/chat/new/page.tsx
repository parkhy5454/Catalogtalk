'use client'
// Start a conversation by typing the other company's business number.
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { normalizeBusinessNumber } from '@/lib/business/number'

export default function NewChatPage() {
  const router = useRouter()
  const supabase = createClient()
  const [number, setNumber] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const start = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    const digits = normalizeBusinessNumber(number)
    if (!digits) {
      setError('사업자등록번호 10자리를 정확히 입력해 주세요')
      return
    }
    setBusy(true)
    setError(null)
    const { data, error: findErr } = await supabase.rpc('find_business_member', { p_number: digits })
    const found = Array.isArray(data) ? data[0] : null
    if (findErr || !found) {
      setError('이 번호로 인증된 사업자 회원을 찾지 못했어요')
      setBusy(false)
      return
    }
    const { data: threadId, error: openErr } = await supabase.rpc('open_chat', { p_other: found.user_id })
    if (openErr || !threadId) {
      setError(openErr?.message?.includes('대화할 수 없는') ? '대화할 수 없는 상대예요' : '대화를 시작하지 못했어요')
      setBusy(false)
      return
    }
    router.push(`/dashboard/chat/${threadId}`)
  }

  return (
    <main className="container section">
      <section className="panel">
        <div className="panel-head">
          <h1 className="panel-title">새 대화</h1>
        </div>
        <form onSubmit={start} className="form-stack">
          <p style={{ fontSize: 13, color: 'var(--muted)' }}>
            대화할 회사의 사업자등록번호 10자리를 입력해 주세요.
          </p>
          <label className="field">
            <span className="field-label">사업자등록번호</span>
            <input
              className="input"
              inputMode="numeric"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              placeholder="000-00-00000"
              maxLength={12}
              disabled={busy}
            />
          </label>
          {error && <div className="notice notice-error" role="alert">{error}</div>}
          <button type="submit" className="btn btn-primary btn-block" disabled={busy || !number.trim()}>
            {busy ? '찾는 중...' : '대화 시작'}
          </button>
        </form>
      </section>
    </main>
  )
}
