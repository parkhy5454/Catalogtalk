'use client'
// Business member registration: enter the business number to use business chat.
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'

export default function BusinessPage() {
  const supabase = createClient()
  const [loaded, setLoaded] = useState(false)
  const [isBusiness, setIsBusiness] = useState(false)
  const [number, setNumber] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)

  useEffect(() => {
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return setLoaded(true)
      const { data } = await supabase.from('customers').select('is_business').eq('user_id', user.id).maybeSingle()
      setIsBusiness(data?.is_business === true)
      setLoaded(true)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch('/api/business/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ number }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setMessage({ kind: 'error', text: body.error ?? '저장하지 못했어요' })
        setBusy(false)
        return
      }
      setIsBusiness(true)
      setMessage({ kind: 'success', text: '사업자 인증이 끝났어요' })
    } catch {
      setMessage({ kind: 'error', text: '인터넷 연결을 확인해 주세요' })
    }
    setBusy(false)
  }

  return (
    <main className="container section">
      <section className="panel">
        <div className="panel-head">
          <h1 className="panel-title">사업자 인증</h1>
        </div>
        {!loaded ? (
          <div className="skeleton" style={{ height: 120 }} aria-hidden="true" />
        ) : isBusiness ? (
          <>
            <div className="notice notice-success">사업자 인증이 완료된 계정이에요.</div>
            <Link href="/dashboard/chat" className="btn btn-primary btn-block" style={{ marginTop: 16 }}>
              사업자 대화 열기
            </Link>
          </>
        ) : (
          <form onSubmit={submit} className="form-stack">
            <p style={{ fontSize: 13, color: 'var(--muted)' }}>
              사업자 대화는 사업자등록번호를 인증한 회원만 쓸 수 있어요. 숫자 10자리를 입력해 주세요.
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
            {message && (
              <div className={`notice ${message.kind === 'error' ? 'notice-error' : 'notice-success'}`} role="status">
                {message.text}
              </div>
            )}
            <button type="submit" className="btn btn-primary btn-block" disabled={busy || !number.trim()}>
              {busy ? '확인 중...' : '인증하기'}
            </button>
          </form>
        )}
      </section>
    </main>
  )
}
