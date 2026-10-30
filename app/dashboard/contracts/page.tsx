'use client'
// Standard contract from an accepted quote. Hidden until CONTRACT_FEATURE_ON is turned on (after legal review).
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { CONTRACT_FEATURE_ON } from '@/lib/contracts/flags'
import { DEFAULT_TERMS, buildContractBody } from '@/lib/contracts/template'

type Quote = { id: string; name: string; company: string | null; memo: string }
type Contract = { id: string; token: string; title: string; buyer_name: string; status: string; agreed_at: string | null; amount: number }

export default function ContractsPage() {
  const supabase = createClient()
  const [quotes, setQuotes] = useState<Quote[]>([])
  const [contracts, setContracts] = useState<Contract[]>([])
  const [pick, setPick] = useState<Quote | null>(null)
  const [title, setTitle] = useState('')
  const [amountText, setAmountText] = useState('')
  const [terms, setTerms] = useState(DEFAULT_TERMS)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string; link?: string } | null>(null)

  const load = async () => {
    const [q, c] = await Promise.all([
      supabase.from('quote_requests').select('id, name, company, memo').order('created_at', { ascending: false }).limit(50),
      supabase.from('contracts').select('id, token, title, buyer_name, status, agreed_at, amount').order('created_at', { ascending: false }).limit(100),
    ])
    setQuotes((q.data as Quote[]) ?? [])
    setContracts((c.data as Contract[]) ?? [])
  }

  useEffect(() => {
    if (CONTRACT_FEATURE_ON) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!CONTRACT_FEATURE_ON) {
    return (
      <main className="container section">
        <section className="panel">
          <div className="panel-head">
            <h1 className="panel-title">계약서</h1>
            <Link href="/dashboard/settings" className="btn btn-ghost">← 설정</Link>
          </div>
          <div className="notice notice-info" style={{ marginTop: 12 }}>계약서 기능은 준비 중이에요. 표준 조건을 검토한 뒤 열어 드릴게요.</div>
        </section>
      </main>
    )
  }

  const create = async () => {
    if (!pick) return
    const amount = Math.round(Number(amountText.replace(/,/g, '')))
    if (!Number.isFinite(amount) || amount < 0 || !title.trim()) {
      return setNotice({ kind: 'error', text: '제목과 금액을 확인해 주세요' })
    }
    setBusy(true)
    setNotice(null)
    const { data: { user } } = await supabase.auth.getUser()
    const { data: cust } = await supabase.from('customers').select('company_name, name').eq('user_id', user?.id ?? '').maybeSingle()
    const sellerName = cust?.company_name || cust?.name || '판매자'
    const body = buildContractBody({
      sellerName,
      buyerName: pick.name,
      buyerCompany: pick.company,
      amount,
      terms,
    })
    const { data, error } = await supabase
      .from('contracts')
      .insert({ user_id: user!.id, quote_id: pick.id, title: title.trim(), buyer_name: pick.name, buyer_company: pick.company, body, amount })
      .select('token')
      .single()
    setBusy(false)
    if (error || !data) return setNotice({ kind: 'error', text: '만들지 못했어요' })
    setNotice({ kind: 'success', text: '계약서를 만들었어요. 링크를 구매자에게 보내 주세요.', link: `${window.location.origin}/contract/${data.token}` })
    setPick(null)
    setTitle('')
    setAmountText('')
    await load()
  }

  return (
    <main className="container section">
      <section className="panel">
        <div className="panel-head">
          <h1 className="panel-title">계약서</h1>
          <Link href="/dashboard/settings" className="btn btn-ghost">← 설정</Link>
        </div>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
          견적 요청을 골라 표준 조건으로 계약서를 만들어요. 구매자는 링크에서 내용을 보고 동의를 누르면 돼요.
          전자서명 인증이 아닌 기록용 동의예요.
        </p>

        {notice && (
          <div className={`notice ${notice.kind === 'error' ? 'notice-error' : 'notice-success'}`} role="status" style={{ marginTop: 12 }}>
            {notice.text}
            {notice.link && <div style={{ marginTop: 6, wordBreak: 'break-all', fontSize: 12 }}>{notice.link}</div>}
          </div>
        )}

        <h2 className="panel-title" style={{ fontSize: 16, marginTop: 16 }}>견적에서 만들기</h2>
        {quotes.length === 0 ? (
          <div className="notice notice-info" style={{ marginTop: 8 }}>견적 요청이 있어야 계약서를 만들 수 있어요.</div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', display: 'grid', gap: 6 }}>
            {quotes.map((q) => (
              <li key={q.id} className="info-box" style={{ display: 'grid', gap: 6, fontSize: 13 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <strong className="truncate">{q.company ? `${q.company} · ` : ''}{q.name}</strong>
                  <button type="button" className="btn btn-ghost" onClick={() => { setPick(pick?.id === q.id ? null : q); setTitle(`${q.name} 거래 계약`) }}>
                    {pick?.id === q.id ? '닫기' : '계약서 만들기'}
                  </button>
                </div>
                {pick?.id === q.id && (
                  <div style={{ display: 'grid', gap: 6 }}>
                    <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} placeholder="계약 제목" disabled={busy} />
                    <input className="input" value={amountText} onChange={(e) => setAmountText(e.target.value)} inputMode="numeric" placeholder="거래 금액 (원)" disabled={busy} />
                    <textarea className="input" value={terms} onChange={(e) => setTerms(e.target.value)} rows={10} disabled={busy} style={{ resize: 'vertical' }} />
                    <button type="button" className="btn btn-primary" onClick={create} disabled={busy}>계약서 만들기</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        <h2 className="panel-title" style={{ fontSize: 16, marginTop: 20 }}>만든 계약서</h2>
        {contracts.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 8 }}>아직 없어요.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', display: 'grid', gap: 6, fontSize: 13 }}>
            {contracts.map((c) => (
              <li key={c.id} className="info-box" style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span className="truncate">{c.title}</span>
                <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{c.status === 'agreed' ? '동의 완료' : '동의 대기'}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
