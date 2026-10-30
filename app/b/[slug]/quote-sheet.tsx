'use client'
// Quote request form in the viewer (when the publisher turned it on). Visitor says what they need;
// the publisher answers by phone, email or a quote link.
import { useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'

type Props = {
  flipbookId: string
  session: string
  onClose: () => void
}

const field: React.CSSProperties = {
  width: '100%',
  padding: '12px 14px',
  fontSize: 16,
  border: '1px solid #ddd',
  borderRadius: 10,
  boxSizing: 'border-box',
  fontFamily: 'inherit',
}

export default function QuoteSheet({ flipbookId, session, onClose }: Props) {
  const [name, setName] = useState('')
  const [contact, setContact] = useState('')
  const [company, setCompany] = useState('')
  const [memo, setMemo] = useState('')
  const [agree, setAgree] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!agree || busy) return
    setBusy(true)
    setError(null)
    const { error: err } = await createClient().rpc('submit_quote_request', {
      p_flipbook: flipbookId,
      p_name: name,
      p_contact: contact,
      p_company: company,
      p_memo: memo,
      p_session: session,
    })
    setBusy(false)
    if (err) {
      setError(err.message || '보내지 못했어요. 잠시 후 다시 해 주세요.')
      return
    }
    setSent(true)
    // Let the publisher's CRM hear about it now (retries and failures are handled on the server).
    fetch('/api/webhooks/dispatch', { method: 'POST', keepalive: true }).catch(() => undefined)
  }

  const canSend = name.trim() && contact.trim() && memo.trim() && agree && !busy

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="quote-title"
      style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 480,
          maxHeight: '88vh',
          overflowY: 'auto',
          background: '#fff',
          color: '#111',
          borderRadius: '16px 16px 0 0',
          padding: '20px 18px calc(20px + env(safe-area-inset-bottom))',
          boxSizing: 'border-box',
        }}
      >
        {sent ? (
          <>
            <h2 id="quote-title" style={{ fontSize: 18, margin: '0 0 8px' }}>요청을 보냈어요</h2>
            <p style={{ fontSize: 14, color: '#555', margin: '0 0 16px' }}>담당자가 확인한 뒤 연락드릴 거예요.</p>
            <button type="button" onClick={onClose} style={{ width: '100%', padding: 14, fontSize: 16, borderRadius: 10, border: 0, background: '#111', color: '#fff' }}>
              계속 보기
            </button>
          </>
        ) : (
          <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
            <div>
              <h2 id="quote-title" style={{ fontSize: 18, margin: 0 }}>견적 요청</h2>
              <p style={{ fontSize: 13, color: '#666', margin: '6px 0 0' }}>필요한 상품과 수량을 적어 주세요. 담당자가 답해 드릴 거예요.</p>
            </div>

            <label style={{ display: 'grid', gap: 6, fontSize: 13 }}>
              이름
              <input style={field} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoComplete="name" disabled={busy} />
            </label>
            <label style={{ display: 'grid', gap: 6, fontSize: 13 }}>
              연락처 (휴대폰 번호 또는 이메일)
              <input style={field} value={contact} onChange={(e) => setContact(e.target.value)} maxLength={120} inputMode="tel" disabled={busy} />
            </label>
            <label style={{ display: 'grid', gap: 6, fontSize: 13 }}>
              회사명 (선택)
              <input style={field} value={company} onChange={(e) => setCompany(e.target.value)} maxLength={60} disabled={busy} />
            </label>
            <label style={{ display: 'grid', gap: 6, fontSize: 13 }}>
              요청 내용
              <textarea style={{ ...field, minHeight: 110, resize: 'vertical' }} value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={1000} placeholder="예: A-101 상품 50개, 배송 희망일 11월 중순" disabled={busy} />
            </label>

            <label style={{ display: 'flex', gap: 8, fontSize: 13, alignItems: 'flex-start' }}>
              <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} disabled={busy} style={{ marginTop: 3 }} />
              <span>
                <strong>[필수]</strong> 이름과 연락처를 이 자료의 발행자에게 전달하는 데 동의해요.{' '}
                <Link href="/privacy" target="_blank" style={{ color: '#555' }}>개인정보 처리방침</Link>
              </span>
            </label>

            {error && <div role="alert" style={{ fontSize: 13, color: '#c0392b' }}>{error}</div>}

            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button type="button" onClick={onClose} disabled={busy} style={{ flex: 1, padding: 14, fontSize: 15, borderRadius: 10, border: '1px solid #ddd', background: '#fff', color: '#333' }}>
                닫기
              </button>
              <button type="submit" disabled={!canSend} style={{ flex: 1, padding: 14, fontSize: 15, borderRadius: 10, border: 0, background: canSend ? '#111' : '#bbb', color: '#fff' }}>
                {busy ? '보내는 중...' : '요청 보내기'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
