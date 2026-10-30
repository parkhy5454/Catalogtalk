'use client'
// Start a conversation by entering the other member's friend code (설정 → 친구 추천).
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export default function NewChatPage() {
  const router = useRouter()
  const supabase = createClient()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const start = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    const clean = code.replace(/\s/g, '').toUpperCase()
    if (clean.length !== 8) {
      setError('친구 코드 8자리를 입력해 주세요')
      return
    }
    setBusy(true)
    setError(null)
    const { data, error: findErr } = await supabase.rpc('find_chat_partner', { p_code: clean })
    const found = Array.isArray(data) ? data[0] : null
    if (findErr || !found) {
      setError('이 코드의 회원을 찾지 못했어요')
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
            상대방의 친구 코드 8자리를 입력해 주세요. 내 코드는 설정 → 친구 추천에서 볼 수 있어요.
          </p>
          <label className="field">
            <span className="field-label">친구 코드</span>
            <input
              className="input"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="예: AB12CD34"
              maxLength={12}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              disabled={busy}
            />
          </label>
          {error && <div className="notice notice-error" role="alert">{error}</div>}
          <button type="submit" className="btn btn-primary btn-block" disabled={busy || !code.trim()}>
            {busy ? '찾는 중...' : '대화 시작'}
          </button>
        </form>
      </section>
    </main>
  )
}
