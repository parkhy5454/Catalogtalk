'use client'
// One customer: stage, consultation notes, and a timeline of visits, inquiries, quotes, orders and sends.
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { SITE_URL as SITE } from '@/lib/site'
import { STAGES, TIMELINE_LABEL, stageLabel, type StageKey } from '@/lib/crm'

type Lead = { id: string; name: string; contact: string; stage: StageKey; flipbook_id: string; tier_id: string | null }
type Tier = { id: string; name: string; discount_pct: number }
type Link = { token: string; created_at: string }
type Restricted = { id: string; name: string }
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
  const [tiers, setTiers] = useState<Tier[]>([])
  const [link, setLink] = useState<Link | null>(null)
  const [slug, setSlug] = useState('')
  const [restricted, setRestricted] = useState<Restricted[]>([])
  const [access, setAccess] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    const supabase = createClient()
    const [l, tl, nt] = await Promise.all([
      supabase.from('flipbook_leads').select('id, name, contact, stage, flipbook_id, tier_id').eq('id', id).maybeSingle(),
      supabase.rpc('get_customer_timeline', { p_lead: id }),
      supabase.from('lead_notes').select('id, body, created_at').eq('lead_id', id).order('created_at', { ascending: false }),
    ])
    if (!l.data) return setNotFound(true)
    setLead(l.data as Lead)
    const fbId = (l.data as Lead).flipbook_id
    const [tr, lk, bk, rs, ac] = await Promise.all([
      supabase.from('price_tiers').select('id, name, discount_pct').eq('flipbook_id', fbId).order('created_at'),
      supabase.from('customer_links').select('token, created_at').eq('lead_id', id).is('revoked_at', null).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('flipbooks').select('slug').eq('id', fbId).maybeSingle(),
      supabase.from('catalog_products').select('id, name').eq('flipbook_id', fbId).eq('visibility', 'restricted').order('page_no', { ascending: true }),
      supabase.from('product_access').select('product_id').eq('lead_id', id),
    ])
    setTiers((tr.data as Tier[]) ?? [])
    setLink((lk.data as Link | null) ?? null)
    setSlug(bk.data?.slug ?? '')
    setRestricted((rs.data as Restricted[]) ?? [])
    setAccess(new Set(((ac.data as { product_id: string }[]) ?? []).map((r) => r.product_id)))
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

  const setTier = async (tierId: string) => {
    if (!lead) return
    const { error: err } = await createClient().from('flipbook_leads').update({ tier_id: tierId || null }).eq('id', lead.id)
    if (err) return setError('등급을 바꾸지 못했어요')
    await load()
  }

  const makeLink = async () => {
    if (!lead) return
    const token = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    const { error: err } = await createClient().from('customer_links').insert({ token, flipbook_id: lead.flipbook_id, lead_id: lead.id })
    if (err) return setError('고객 링크를 만들지 못했어요')
    await load()
  }

  const revokeLink = async () => {
    if (!link || !window.confirm('이 링크를 끊을까요? 링크로 보던 고객은 더 이상 전용 가격을 못 봐요.')) return
    const { error: err } = await createClient().from('customer_links').update({ revoked_at: new Date().toISOString() }).eq('token', link.token)
    if (err) return setError('링크를 끊지 못했어요')
    await load()
  }

  const toggleAccess = async (productId: string, on: boolean) => {
    if (!lead) return
    const supabase = createClient()
    const { error: err } = on
      ? await supabase.from('product_access').insert({ product_id: productId, lead_id: lead.id, flipbook_id: lead.flipbook_id })
      : await supabase.from('product_access').delete().eq('product_id', productId).eq('lead_id', lead.id)
    if (err) return setError('바꾸지 못했어요')
    await load()
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
        <h2 className="panel-title" style={{ fontSize: 16 }}>고객 전용 카탈로그</h2>
        <label className="field" style={{ marginTop: 10 }}>
          <span className="field-label">거래처 등급</span>
          <select className="input" value={lead?.tier_id ?? ''} onChange={(e) => setTier(e.target.value)} disabled={!lead}>
            <option value="">일반 고객</option>
            {tiers.map((t) => <option key={t.id} value={t.id}>{t.name} · {t.discount_pct}% 할인</option>)}
          </select>
        </label>
        <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
          <span style={{ fontSize: 13 }}>전용 링크</span>
          {link ? (
            <>
              <code style={{ fontSize: 11, wordBreak: 'break-all', color: 'var(--muted)' }}>{`${SITE}/b/${slug}?t=${link.token}`}</code>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-ghost" onClick={() => navigator.clipboard?.writeText(`${SITE}/b/${slug}?t=${link.token}`).catch(() => undefined)}>링크 복사</button>
                <button type="button" className="btn btn-ghost" onClick={revokeLink}>링크 끊기</button>
              </div>
            </>
          ) : (
            <button type="button" className="btn btn-ghost" onClick={makeLink} disabled={!lead || !slug}>전용 링크 만들기</button>
          )}
        </div>
        {restricted.length > 0 && (
          <div style={{ marginTop: 12, display: 'grid', gap: 6 }}>
            <span style={{ fontSize: 13 }}>고객 전용 상품 보여 주기</span>
            {restricted.map((r) => (
              <label key={r.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                <input type="checkbox" checked={access.has(r.id)} onChange={(e) => toggleAccess(r.id, e.target.checked)} />
                {r.name}
              </label>
            ))}
          </div>
        )}
        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10 }}>전용 링크로 들어온 고객만 등급 가격과 고객 전용 상품을 봐요. 링크는 고객에게 직접 보내 주세요.</p>
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
