'use client'
// One customer: stage, consultation notes, and a timeline of visits, inquiries, quotes, orders and sends.
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { STAGES, TIMELINE_LABEL, stageLabel, type StageKey } from '@/lib/crm'

type Lead = { id: string; name: string; contact: string; stage: StageKey; flipbook_id: string }
type Event = { kind: string; at: string | null; title: string; detail: string }
type Note = { id: string; body: string; created_at: string }

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' }) : '')

export default function CustomerPage() {
  const { id } = useParams<{ id: string }>()
  const [lead, setLead] = useState<Lead | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [events, setEvents] = useState<Event[] | null>(null)
  const [notes, setNotes] = useState<Note[]>([])
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const supabase = createClient()
    const [l, tl, nt] = await Promise.all([
      supabase.from('flipbook_leads').select('id, name, contact, stage, flipbook_id').eq('id', id).maybeSingle(),
      supabase.rpc('get_customer_timeline', { p_lead: id }),
      supabase.from('lead_notes').select('id, body, created_at').eq('lead_id', id).order('created_at', { ascending: false }),
    ])
    if (!l.data) return setNotFound(true)
    setLead(l.data as Lead)
    if (tl.error) setError('기록을 불러오지 못했어요')
    setEvents((tl.data as Event[]) ?? [])
    setNotes((nt.data as Note[]) ?? [])
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const setStage = async (stage: StageKey) => {
    if (!lead) return
    const { error: err } = await createClient().from('flipbook_leads').update({ stage }).eq('id', lead.id)
    if (err) return setError('단계를 바꾸지 못했어요')
    setLead({ ...lead, stage })
  }

  const addNote = async (e: React.FormEvent) => {
    e.preventDefault()
    const text = body.trim()
    if (!lead || !text || busy) return
    setBusy(true)
    setError(null)
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      setBusy(false)
      return setError('로그인이 필요해요')
    }
    const { error: err } = await supabase.from('lead_notes').insert({
      lead_id: lead.id, flipbook_id: lead.flipbook_id, owner_id: user.id, body: text.slice(0, 1000),
    })
    setBusy(false)
    if (err) return setError('메모를 저장하지 못했어요')
    setBody('')
    await load()
  }

  const removeNote = async (noteId: string) => {
    if (!window.confirm('이 메모를 지울까요?')) return
    const { error: err } = await createClient().from('lead_notes').delete().eq('id', noteId)
    if (err) return setError('메모를 지우지 못했어요')
    await load()
  }

  if (notFound) {
    return (
      <main className="container section">
        <div className="notice notice-error">고객을 찾을 수 없어요.</div>
        <Link href="/dashboard/pipeline" className="btn btn-ghost btn-block" style={{ marginTop: 16 }}>파이프라인으로</Link>
      </main>
    )
  }

  const reorderDue = (events ?? []).filter((e) => e.kind === 'reorder_due')
  const lastOrder = (events ?? []).find((e) => e.kind === 'order')

  return (
    <main className="container section">
      <Link href="/dashboard/pipeline" className="btn btn-ghost" style={{ marginBottom: 12 }}>← 파이프라인</Link>
      <section className="panel">
        <h1 className="panel-title" style={{ wordBreak: 'keep-all' }}>{lead?.name ?? '고객'}</h1>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>{lead?.contact}</p>
        <label className="field" style={{ marginTop: 12 }}>
          <span className="field-label">단계</span>
          <select className="input" value={lead?.stage ?? 'contact'} onChange={(e) => setStage(e.target.value as StageKey)} disabled={!lead}>
            {STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </label>

        <div className="info-box" style={{ marginTop: 12, display: 'grid', gap: 4, fontSize: 13 }}>
          <span>최근 주문: {lastOrder ? `${fmt(lastOrder.at)} · ${lastOrder.detail}` : '없음'}</span>
          <span>재구매 시기: {reorderDue.length === 0 ? '설정된 재구매 알림이 없어요' : reorderDue.map((r) => `${r.detail} ${fmt(r.at)}`).join(' / ')}</span>
        </div>
        {error && <div className="notice notice-error" role="alert" style={{ marginTop: 10 }}>{error}</div>}
      </section>

      <section className="panel" style={{ marginTop: 16 }}>
        <h2 className="panel-title" style={{ fontSize: 16 }}>상담 메모</h2>
        <form onSubmit={addNote} style={{ display: 'grid', gap: 8, marginTop: 10 }}>
          <textarea className="input" value={body} onChange={(e) => setBody(e.target.value)} maxLength={1000} rows={3} placeholder="통화·미팅 내용, 다음 약속 등" disabled={busy} />
          <button type="submit" className="btn btn-primary" disabled={!body.trim() || busy}>{busy ? '저장 중...' : '메모 남기기'}</button>
        </form>
        {notes.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 10 }}>아직 메모가 없어요.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: '10px 0 0', display: 'grid', gap: 8 }}>
            {notes.map((n) => (
              <li key={n.id} className="info-box" style={{ fontSize: 13, display: 'grid', gap: 4 }}>
                <span style={{ whiteSpace: 'pre-wrap' }}>{n.body}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', justifyContent: 'space-between' }}>
                  {fmt(n.created_at)}
                  <button type="button" className="btn btn-ghost" onClick={() => removeNote(n.id)}>삭제</button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel" style={{ marginTop: 16 }}>
        <h2 className="panel-title" style={{ fontSize: 16 }}>기록</h2>
        {events === null ? (
          <div className="skeleton" style={{ height: 120, marginTop: 8 }} aria-hidden="true" />
        ) : events.filter((e) => e.kind !== 'reorder_due').length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 8 }}>기록이 없어요.</p>
        ) : (
          <ol style={{ listStyle: 'none', padding: 0, margin: '10px 0 0', display: 'grid', gap: 8 }}>
            {events.filter((e) => e.kind !== 'reorder_due').map((e, i) => (
              <li key={i} style={{ display: 'grid', gridTemplateColumns: '48px 1fr', gap: 8, fontSize: 13 }}>
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>{TIMELINE_LABEL[e.kind] ?? e.kind}</span>
                <span style={{ minWidth: 0 }}>
                  <strong>{e.title}</strong>
                  <span style={{ display: 'block', color: 'var(--muted)' }}>{e.detail}</span>
                  <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)' }}>{fmt(e.at)}</span>
                </span>
              </li>
            ))}
          </ol>
        )}
        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10 }}>
          이 고객의 단계는 {lead ? stageLabel(lead.stage) : '-'}예요. 카카오톡 공유와 링크 전달은 아직 기록되지 않아요.
        </p>
      </section>
    </main>
  )
}
