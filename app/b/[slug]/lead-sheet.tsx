'use client'
// Contact sheet shown in the viewer when the publisher turned on lead collection.
// Visitors may skip it; skipping or submitting shows it only once per browser.
import { useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'

const DONE_KEY = 'catalogtalk-lead-'

export function leadDone(flipbookId: string): boolean {
  try {
    return localStorage.getItem(DONE_KEY + flipbookId) === '1'
  } catch {
    return false
  }
}

function markLeadDone(flipbookId: string) {
  try {
    localStorage.setItem(DONE_KEY + flipbookId, '1')
  } catch {
    /* private mode: the sheet may show again */
  }
}

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
}

export default function LeadSheet({ flipbookId, session, onClose }: Props) {
  const [name, setName] = useState('')
  const [contact, setContact] = useState('')
  const [agree, setAgree] = useState(false)
  const [marketing, setMarketing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  const close = () => {
    markLeadDone(flipbookId)
    onClose()
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!agree || busy) return
    setBusy(true)
    setError(null)
    const { error: err } = await createClient().rpc('submit_lead', {
      p_flipbook: flipbookId,
      p_name: name,
      p_contact: contact,
      p_marketing: marketing,
      p_session: session,
    })
    setBusy(false)
    if (err) {
      setError(err.message || '보내지 못했어요. 잠시 후 다시 해 주세요.')
      return
    }
    setSent(true)
    markLeadDone(flipbookId)
    // Let the publisher's CRM hear about it now (retries and failures are handled on the server).
    fetch('/api/webhooks/dispatch', { method: 'POST', keepalive: true }).catch(() => undefined)
  }

  const canSend = name.trim().length > 0 && contact.trim().length > 0 && agree && !busy

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="lead-title"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 480,
          maxHeight: '85vh',
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
            <h2 id="lead-title" style={{ fontSize: 18, margin: '0 0 8px' }}>감사합니다</h2>
            <p style={{ fontSize: 14, color: '#555', margin: '0 0 16px' }}>연락처를 남겨 주셔서 고마워요. 계속 보실 수 있어요.</p>
            <button type="button" onClick={onClose} style={{ width: '100%', padding: 14, fontSize: 16, borderRadius: 10, border: 0, background: '#111', color: '#fff' }}>
              계속 보기
            </button>
          </>
        ) : (
          <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
            <div>
              <h2 id="lead-title" style={{ fontSize: 18, margin: 0 }}>연락처를 남겨 주세요</h2>
              <p style={{ fontSize: 13, color: '#666', margin: '6px 0 0' }}>
                이 자료를 보낸 곳에서 필요한 내용을 연락드릴 수 있어요.
              </p>
            </div>

            <label style={{ display: 'grid', gap: 6, fontSize: 13 }}>
              이름
              <input style={field} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoComplete="name" disabled={busy} />
            </label>

            <label style={{ display: 'grid', gap: 6, fontSize: 13 }}>
              연락처 (휴대폰 번호 또는 이메일)
              <input style={field} value={contact} onChange={(e) => setContact(e.target.value)} maxLength={120} autoComplete="tel" inputMode="tel" disabled={busy} />
            </label>

            <label style={{ display: 'flex', gap: 8, fontSize: 13, alignItems: 'flex-start' }}>
              <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} disabled={busy} style={{ marginTop: 3 }} />
              <span>
                <strong>[필수]</strong> 이름과 연락처를 이 자료의 발행자에게 전달하는 데 동의해요.
                <br />
                <span style={{ color: '#777' }}>보관 기간은 1년이며, 그 뒤 자동 삭제돼요. </span>
                <Link href="/privacy" target="_blank" style={{ color: '#555' }}>개인정보 처리방침</Link>
              </span>
            </label>

            <label style={{ display: 'flex', gap: 8, fontSize: 13, alignItems: 'flex-start' }}>
              <input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} disabled={busy} style={{ marginTop: 3 }} />
              <span>[선택] 소식이나 광고성 정보를 받는 데 동의해요.</span>
            </label>

            {error && <div role="alert" style={{ fontSize: 13, color: '#c0392b' }}>{error}</div>}

            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button type="button" onClick={close} disabled={busy} style={{ flex: 1, padding: 14, fontSize: 15, borderRadius: 10, border: '1px solid #ddd', background: '#fff', color: '#333' }}>
                나중에
              </button>
              <button type="submit" disabled={!canSend} style={{ flex: 1, padding: 14, fontSize: 15, borderRadius: 10, border: 0, background: canSend ? '#111' : '#bbb', color: '#fff' }}>
                {busy ? '보내는 중...' : '보내기'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
