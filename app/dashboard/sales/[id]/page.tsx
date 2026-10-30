'use client'
// AI sales view: which products drew attention, which buyers are most likely to buy, and a follow-up draft per buyer.
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { SALES_AI_FREE_MONTHLY } from '@/lib/sales/limits'

type Interest = { product_id: string; product_name: string; product_page: number | null; product_price: number | null; viewers: number; dwell_ms: number; ordered_qty: number }
type Buyer = { lead_id: string; lead_name: string | null; lead_contact: string; tier: 'hot' | 'warm' | 'cold'; score: number; ordered: boolean; asked: boolean; dwell_ms: number; viewed_products: string[] }

const TIER: Record<Buyer['tier'], { label: string; color: string }> = {
  hot: { label: '구매 가능성 높음', color: '#c0392b' },
  warm: { label: '관심 있음', color: '#b9770e' },
  cold: { label: '둘러보는 중', color: '#777' },
}

export default function SalesPage() {
  const { id } = useParams<{ id: string }>()
  const [title, setTitle] = useState('')
  const [notFound, setNotFound] = useState(false)
  const [interest, setInterest] = useState<Interest[] | null>(null)
  const [buyers, setBuyers] = useState<Buyer[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [drafting, setDrafting] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [draftError, setDraftError] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    const supabase = createClient()
    const [book, pi, bi] = await Promise.all([
      supabase.from('flipbooks').select('title').eq('id', id).maybeSingle(),
      supabase.rpc('get_product_interest', { p_flipbook: id }),
      supabase.rpc('get_buyer_intent', { p_flipbook: id }),
    ])
    if (!book.data) return setNotFound(true)
    setTitle(book.data.title)
    if (pi.error || bi.error) return setError('분석 결과를 불러오지 못했어요')
    setInterest((pi.data as Interest[]) ?? [])
    setBuyers((bi.data as Buyer[]) ?? [])
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const draft = async (leadId: string) => {
    setDrafting(leadId)
    setDraftError((e) => ({ ...e, [leadId]: '' }))
    try {
      const res = await fetch('/api/ai/followup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flipbook_id: id, lead_id: leadId }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? '초안을 만들지 못했어요')
      setDrafts((d) => ({ ...d, [leadId]: body.draft as string }))
    } catch (e) {
      setDraftError((d) => ({ ...d, [leadId]: e instanceof Error ? e.message : '초안을 만들지 못했어요' }))
    } finally {
      setDrafting(null)
    }
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      /* clipboard can be blocked; the text stays selectable */
    }
  }

  if (notFound) {
    return (
      <main className="container section">
        <div className="notice notice-error">자료를 찾을 수 없어요.</div>
        <Link href="/dashboard" className="btn btn-ghost btn-block" style={{ marginTop: 16 }}>대시보드로 돌아가기</Link>
      </main>
    )
  }

  const total = buyers?.length ?? 0
  const hot = buyers?.filter((b) => b.tier === 'hot').length ?? 0
  const converted = buyers?.filter((b) => b.ordered || b.asked).length ?? 0
  const rate = total === 0 ? 0 : Math.round((converted / total) * 100)
  const topProduct = interest?.find((p) => p.viewers > 0)

  return (
    <main className="container section">
      <Link href={`/dashboard/stats/${id}`} className="btn btn-ghost" style={{ marginBottom: 12 }}>← 통계</Link>
      <h1 className="panel-title" style={{ wordBreak: 'keep-all' }}>{title} · AI 영업 분석</h1>
      <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
        열람 기록과 주문·견적 기록으로 계산해요. AI 초안은 월 {SALES_AI_FREE_MONTHLY}건까지 무료예요.
      </p>

      {error && <div className="notice notice-error" role="alert" style={{ marginTop: 12 }}>{error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginTop: 14 }}>
        <Kpi label="열람한 고객" value={total} />
        <Kpi label="구매 가능성 높음" value={hot} accent="#c0392b" />
        <Kpi label="주문·견적 전환율" value={`${rate}%`} sub={`${converted}명 / ${total}명`} />
        <Kpi label="가장 관심 받은 상품" value={topProduct ? topProduct.product_name : '-'} small />
      </div>

      <section className="panel" style={{ marginTop: 16 }}>
        <h2 className="panel-title" style={{ fontSize: 16 }}>상품 관심도</h2>
        {interest === null ? (
          <div className="skeleton" style={{ height: 80, marginTop: 8 }} aria-hidden="true" />
        ) : interest.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 8 }}>
            등록된 상품이 없어요. <Link href={`/dashboard/products/${id}`}>상품 관리</Link>에서 먼저 등록해 주세요.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', display: 'grid', gap: 8 }}>
            {interest.map((p) => (
              <li key={p.product_id} className="info-box" style={{ fontSize: 13 }}>
                <strong>{p.product_name}</strong>
                <span style={{ color: 'var(--muted)' }}>
                  {p.product_page ? ` · ${p.product_page}쪽` : ''} · {p.viewers}명이 봄 · 총 {Math.round(p.dwell_ms / 60000)}분 · 주문 {p.ordered_qty}개
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel" style={{ marginTop: 16 }}>
        <h2 className="panel-title" style={{ fontSize: 16 }}>고객 분류</h2>
        {buyers === null ? (
          <div className="skeleton" style={{ height: 120, marginTop: 8 }} aria-hidden="true" />
        ) : buyers.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 8 }}>아직 리드가 없어요. 리드 수집을 켜면 여기에 나와요.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', display: 'grid', gap: 8 }}>
            {buyers.map((b) => {
              const t = TIER[b.tier]
              return (
                <li key={b.lead_id} className="info-box" style={{ display: 'grid', gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                    <strong className="truncate">{b.lead_name || '이름 없음'}</strong>
                    <span style={{ fontSize: 12, color: t.color, whiteSpace: 'nowrap' }}>{t.label} · {b.score}점</span>
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                    본 시간 약 {Math.max(1, Math.round(b.dwell_ms / 60000))}분
                    {b.ordered ? ' · 주문 있음' : ''}{b.asked ? ' · 견적 요청 있음' : ''}
                    {b.viewed_products.length > 0 ? ` · 본 상품: ${b.viewed_products.join(', ')}` : ''}
                  </span>
                  {drafts[b.lead_id] ? (
                    <div style={{ display: 'grid', gap: 6 }}>
                      <textarea className="input" readOnly value={drafts[b.lead_id]} rows={5} style={{ fontSize: 14, lineHeight: 1.6 }} />
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button type="button" className="btn btn-ghost" onClick={() => copy(drafts[b.lead_id])}>복사</button>
                        <button type="button" className="btn btn-ghost" onClick={() => draft(b.lead_id)} disabled={drafting === b.lead_id}>다시 쓰기</button>
                      </div>
                    </div>
                  ) : (
                    <button type="button" className="btn btn-ghost" onClick={() => draft(b.lead_id)} disabled={drafting !== null}>
                      {drafting === b.lead_id ? '초안 쓰는 중...' : 'AI 후속 메시지 초안'}
                    </button>
                  )}
                  {draftError[b.lead_id] && <div className="notice notice-error" role="alert">{draftError[b.lead_id]}</div>}
                </li>
              )
            })}
          </ul>
        )}
        {buyers && hot > 0 && <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10 }}>구매 가능성 높음 고객부터 연락해 보세요.</p>}
      </section>
    </main>
  )
}

function Kpi({ label, value, sub, accent, small }: { label: string; value: React.ReactNode; sub?: string; accent?: string; small?: boolean }) {
  return (
    <div className="info-box" style={{ display: 'grid', gap: 4 }}>
      <span style={{ fontSize: 12, color: 'var(--muted)' }}>{label}</span>
      <strong style={{ fontSize: small ? 14 : 22, color: accent ?? 'inherit', wordBreak: 'keep-all' }}>{value}</strong>
      {sub && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{sub}</span>}
    </div>
  )
}
