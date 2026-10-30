'use client'
// Deal ledger: record a won quote with its amount. The fee is an estimate at the placeholder rate.
// No money moves through the app yet; payments and settlement come later.
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { PLACEHOLDER_FEE_RATE, estimateFee } from '@/lib/deals/fee'

type Quote = { id: string; flipbook_id: string; name: string; company: string | null; memo: string; created_at: string }
type Deal = {
  id: string
  quote_id: string | null
  buyer_name: string
  buyer_company: string | null
  amount: number
  fee_amount: number
  fee_rate: number
  memo: string | null
  closed_on: string
}

const won = (n: number) => `${n.toLocaleString('ko-KR')}원`

export default function DealsPage() {
  const supabase = createClient()
  const [quotes, setQuotes] = useState<Quote[] | null>(null)
  const [deals, setDeals] = useState<Deal[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [amountText, setAmountText] = useState('')
  const [memo, setMemo] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)

  const load = useCallback(async () => {
    const [q, d] = await Promise.all([
      supabase.from('quote_requests').select('id, flipbook_id, name, company, memo, created_at').order('created_at', { ascending: false }).limit(50),
      supabase.from('deals').select('id, quote_id, buyer_name, buyer_company, amount, fee_amount, fee_rate, memo, closed_on').order('closed_on', { ascending: false }).limit(200),
    ])
    setQuotes((q.data as Quote[]) ?? [])
    setDeals((d.data as Deal[]) ?? [])
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const recorded = new Set(deals.map((d) => d.quote_id).filter(Boolean) as string[])
  const total = deals.reduce((s, d) => s + d.amount, 0)
  const fees = deals.reduce((s, d) => s + d.fee_amount, 0)

  const save = async (q: Quote) => {
    const amount = Math.round(Number(amountText.replace(/,/g, '')))
    if (!Number.isFinite(amount) || amount < 0) return setNotice({ kind: 'error', text: '금액을 숫자로 입력해 주세요' })
    setBusy(true)
    setNotice(null)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return setBusy(false)
    const { error } = await supabase.from('deals').insert({
      user_id: user.id,
      quote_id: q.id,
      flipbook_id: q.flipbook_id,
      buyer_name: q.name,
      buyer_company: q.company,
      amount,
      fee_rate: PLACEHOLDER_FEE_RATE,
      fee_amount: estimateFee(amount),
      memo: memo.trim() || null,
    })
    setBusy(false)
    if (error) return setNotice({ kind: 'error', text: '기록하지 못했어요' })
    setOpenId(null)
    setAmountText('')
    setMemo('')
    setNotice({ kind: 'success', text: '거래를 기록했어요.' })
    await load()
  }

  const remove = async (d: Deal) => {
    if (!window.confirm('이 거래 기록을 삭제할까요?')) return
    const { error } = await supabase.from('deals').delete().eq('id', d.id)
    if (error) return setNotice({ kind: 'error', text: '삭제하지 못했어요' })
    await load()
  }

  return (
    <main className="container section">
      <section className="panel">
        <div className="panel-head">
          <h1 className="panel-title">거래 기록</h1>
          <Link href="/dashboard/settings" className="btn btn-ghost">← 설정</Link>
        </div>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
          성사된 견적을 기록하면 수수료를 예상해 볼 수 있어요. 예상 수수료는 임시 요율({Math.round(PLACEHOLDER_FEE_RATE * 100)}%)로 계산해요.
          지금은 돈이 오가지 않고, 장부로만 쓰여요.
        </p>

        <div className="stats" style={{ marginTop: 14 }}>
          <div className="stat"><div className="stat-label">거래 건수</div><div className="stat-value">{deals.length}건</div></div>
          <div className="stat"><div className="stat-label">거래 금액</div><div className="stat-value">{won(total)}</div></div>
          <div className="stat"><div className="stat-label">예상 수수료</div><div className="stat-value">{won(fees)}</div></div>
        </div>

        {notice && (
          <div className={`notice ${notice.kind === 'error' ? 'notice-error' : 'notice-success'}`} role="status" style={{ marginTop: 12 }}>{notice.text}</div>
        )}

        <h2 className="panel-title" style={{ fontSize: 16, marginTop: 20 }}>견적 요청에서 기록하기</h2>
        {quotes === null ? (
          <div className="skeleton" style={{ height: 100, marginTop: 8 }} aria-hidden="true" />
        ) : quotes.length === 0 ? (
          <div className="notice notice-info" style={{ marginTop: 8 }}>아직 견적 요청이 없어요.</div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', display: 'grid', gap: 8 }}>
            {quotes.map((q) => {
              const done = recorded.has(q.id)
              return (
                <li key={q.id} className="info-box" style={{ display: 'grid', gap: 6, fontSize: 13 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <strong className="truncate">{q.company ? `${q.company} · ` : ''}{q.name}</strong>
                    {done ? (
                      <span style={{ color: 'var(--muted)' }}>기록됨</span>
                    ) : (
                      <button type="button" className="btn btn-ghost" onClick={() => { setOpenId(openId === q.id ? null : q.id); setAmountText(''); setMemo('') }}>
                        거래 성사
                      </button>
                    )}
                  </div>
                  <span style={{ color: 'var(--muted)', whiteSpace: 'pre-wrap' }}>{q.memo}</span>
                  {openId === q.id && (
                    <div style={{ display: 'grid', gap: 6, marginTop: 4 }}>
                      <input className="input" value={amountText} onChange={(e) => setAmountText(e.target.value)} inputMode="numeric" placeholder="거래 금액 (원)" disabled={busy} />
                      <input className="input" value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={500} placeholder="메모 (선택)" disabled={busy} />
                      {amountText && Number(amountText.replace(/,/g, '')) > 0 && (
                        <span style={{ color: 'var(--muted)' }}>예상 수수료 {won(estimateFee(Number(amountText.replace(/,/g, ''))))}</span>
                      )}
                      <button type="button" className="btn btn-primary" onClick={() => save(q)} disabled={busy || !amountText.trim()}>기록하기</button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        <h2 className="panel-title" style={{ fontSize: 16, marginTop: 20 }}>거래 목록</h2>
        {deals.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 8 }}>아직 기록한 거래가 없어요.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', display: 'grid', gap: 6, fontSize: 13 }}>
            {deals.map((d) => (
              <li key={d.id} className="info-box" style={{ display: 'grid', gap: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <strong className="truncate">{d.buyer_company ? `${d.buyer_company} · ` : ''}{d.buyer_name}</strong>
                  <span>{won(d.amount)}</span>
                </div>
                <span style={{ color: 'var(--muted)' }}>{d.closed_on} · 예상 수수료 {won(d.fee_amount)} ({Math.round(d.fee_rate * 100)}%)</span>
                {d.memo && <span style={{ color: 'var(--muted)' }}>{d.memo}</span>}
                <button type="button" className="btn btn-ghost" style={{ justifySelf: 'start' }} onClick={() => remove(d)}>삭제</button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
