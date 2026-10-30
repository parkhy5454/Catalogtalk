'use client'
// Owner's notice screen: email the leads who agreed to marketing. Each email has a 수신거부 link.
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { FREE_EMAIL_SENDS } from '@/lib/notify/limits'

type Send = { id: string; subject: string; recipient_count: number; status: string; created_at: string }

export default function NotifyPage() {
  const { id } = useParams<{ id: string }>()
  const supabase = createClient()
  const [title, setTitle] = useState('')
  const [notFound, setNotFound] = useState(false)
  const [recipients, setRecipients] = useState<number | null>(null)
  const [history, setHistory] = useState<Send[]>([])
  const [usedTotal, setUsedTotal] = useState(0)
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)

  const load = useCallback(async () => {
    const [book, count, sends] = await Promise.all([
      supabase.from('flipbooks').select('title').eq('id', id).maybeSingle(),
      supabase.rpc('count_notify_recipients', { p_flipbook: id }),
      supabase.from('notify_sends').select('id, subject, recipient_count, status, created_at').order('created_at', { ascending: false }).limit(20),
    ])
    if (!book.data) return setNotFound(true)
    setTitle(book.data.title)
    setRecipients((count.data as number) ?? 0)
    const list = (sends.data as Send[]) ?? []
    setHistory(list)
    setUsedTotal(list.reduce((s, r) => s + r.recipient_count, 0))
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const remaining = Math.max(0, FREE_EMAIL_SENDS - usedTotal)

  const send = async () => {
    if (!window.confirm(`동의한 ${recipients ?? 0}명에게 이메일을 보낼까요? 보낸 뒤에는 되돌릴 수 없어요.`)) return
    setBusy(true)
    setNotice(null)
    const res = await fetch('/api/notify/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flipbook_id: id, subject, message }),
    })
    const body = (await res.json().catch(() => ({}))) as { error?: string; sent?: number; failed?: number }
    setBusy(false)
    if (!res.ok) return setNotice({ kind: 'error', text: body.error ?? '보내지 못했어요' })
    setNotice({ kind: 'success', text: `${body.sent ?? 0}통을 보냈어요${body.failed ? ` (${body.failed}통 실패)` : ''}.` })
    setSubject('')
    setMessage('')
    await load()
  }

  if (notFound) {
    return (
      <main className="container section">
        <div className="notice notice-error">자료를 찾을 수 없어요.</div>
        <Link href="/dashboard/folders" className="btn btn-ghost btn-block" style={{ marginTop: 16 }}>My Book으로 돌아가기</Link>
      </main>
    )
  }

  const canSend = !busy && subject.trim() && message.trim() && (recipients ?? 0) > 0 && remaining > 0

  return (
    <main className="container section">
      <Link href={`/dashboard/stats/${id}`} className="btn btn-ghost" style={{ marginBottom: 12 }}>← 통계</Link>

      <section className="panel">
        <div className="panel-head">
          <h1 className="panel-title" style={{ wordBreak: 'keep-all' }}>{title} 알림 보내기</h1>
        </div>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
          리드 중 소식 수신에 동의하고 이메일을 남긴 분께만 보내요. 모든 메일 아래에 수신거부 링크가 붙어요.
          문자와 카카오 알림톡은 발송 업체를 정한 뒤 추가할 예정이에요.
        </p>

        <div className="info-box" style={{ marginTop: 12, fontSize: 13 }}>
          <div>받을 수 있는 사람: {recipients === null ? '...' : `${recipients.toLocaleString()}명`}</div>
          <div style={{ color: 'var(--muted)', marginTop: 4 }}>무료 이메일 남은 수: {remaining} / {FREE_EMAIL_SENDS}통</div>
        </div>

        {notice && (
          <div className={`notice ${notice.kind === 'error' ? 'notice-error' : 'notice-success'}`} role="status" style={{ marginTop: 12 }}>
            {notice.text}
          </div>
        )}

        <div className="form-stack" style={{ marginTop: 14 }}>
          <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={80} placeholder="제목 (예: 11월 신제품 카탈로그가 나왔어요)" disabled={busy} />
          <textarea className="input" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} rows={6} placeholder="내용을 적어 주세요. 카탈로그 링크는 자동으로 붙어요." disabled={busy} style={{ resize: 'vertical' }} />
          <button type="button" className="btn btn-primary btn-block" onClick={send} disabled={!canSend}>
            {busy ? '보내는 중...' : '이메일 보내기'}
          </button>
        </div>
        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10 }}>
          광고성 내용이면 메일 제목에 (광고)를 붙이고, 받는 사람이 언제든 거부할 수 있어야 해요. 발신 정보와 수신거부 안내는 자동으로 들어가요.
        </p>
      </section>

      <section className="panel" style={{ marginTop: 16 }}>
        <h2 className="panel-title" style={{ fontSize: 16 }}>보낸 기록</h2>
        {history.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 8 }}>아직 보낸 알림이 없어요.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', display: 'grid', gap: 6, fontSize: 13 }}>
            {history.map((h) => (
              <li key={h.id} className="info-box" style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span className="truncate">{h.subject}</span>
                <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                  {h.recipient_count}명 · {h.status === 'sent' ? '완료' : h.status === 'partial' ? '일부 실패' : '실패'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
