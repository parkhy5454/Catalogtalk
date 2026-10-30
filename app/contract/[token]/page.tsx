'use client'
// Buyer's page for one contract. Reached only through the private link the seller sent.
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

type Contract = {
  title: string
  buyer_name: string
  buyer_company: string | null
  body: string
  amount: number
  status: string
  agreed_at: string | null
  expires_at: string
  seller_company: string | null
}

export default function ContractPage() {
  const { token } = useParams<{ token: string }>()
  const supabase = createClient()
  const [contract, setContract] = useState<Contract | null | 'missing'>(null)
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    ;(async () => {
      const { data } = await supabase.rpc('get_contract', { p_token: token })
      const row = ((data as Contract[]) ?? [])[0]
      setContract(row ?? 'missing')
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  const agree = async () => {
    setBusy(true)
    setError(null)
    const { error: err } = await supabase.rpc('agree_contract', { p_token: token })
    setBusy(false)
    if (err) return setError(err.message)
    const { data } = await supabase.rpc('get_contract', { p_token: token })
    setContract(((data as Contract[]) ?? [])[0] ?? 'missing')
  }

  if (contract === null) {
    return <main className="container section"><div className="skeleton" style={{ height: 200 }} aria-hidden="true" /></main>
  }
  if (contract === 'missing') {
    return <main className="container section"><div className="notice notice-error">계약서를 찾을 수 없어요.</div></main>
  }

  const expired = new Date(contract.expires_at) < new Date() && contract.status !== 'agreed'
  const agreed = contract.status === 'agreed'

  return (
    <main className="container section">
      <section className="panel">
        <h1 className="panel-title" style={{ wordBreak: 'keep-all' }}>{contract.title}</h1>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
          {contract.seller_company ?? '판매자'}가 보낸 계약서예요.
        </p>
        <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 14, lineHeight: 1.7, marginTop: 12 }}>{contract.body}</pre>

        {agreed ? (
          <div className="notice notice-success" role="status" style={{ marginTop: 12 }}>
            {new Date(contract.agreed_at as string).toLocaleString('ko-KR')}에 동의하셨어요.
          </div>
        ) : expired ? (
          <div className="notice notice-error" style={{ marginTop: 12 }}>이 계약서의 확인 기간이 끝났어요. 판매자에게 새 링크를 요청해 주세요.</div>
        ) : (
          <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
            <label style={{ display: 'flex', gap: 8, fontSize: 14, alignItems: 'flex-start' }}>
              <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} disabled={busy} style={{ marginTop: 3 }} />
              <span>위 내용을 확인했고 동의해요.</span>
            </label>
            {error && <div className="notice notice-error" role="alert">{error}</div>}
            <button type="button" className="btn btn-primary btn-block" onClick={agree} disabled={!checked || busy}>
              {busy ? '처리 중...' : '동의하기'}
            </button>
          </div>
        )}
      </section>
    </main>
  )
}
