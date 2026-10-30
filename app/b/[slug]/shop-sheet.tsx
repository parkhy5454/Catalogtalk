'use client'
// Product list with quantity and option, then a quote/order request form (when the publisher takes requests).
// Nothing is paid here: the request goes to the publisher, who confirms it.
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'

export type ShopProduct = {
  id: string
  name: string
  price: number | null
  unit: string | null
  options: string | null
  description: string | null
  page_no: number | null
  image_url?: string | null
}

type Props = {
  flipbookId: string
  session: string
  products: ShopProduct[]
  orderOn: boolean
  initialId?: string | null
  onClose: () => void
}

const field: React.CSSProperties = {
  width: '100%', padding: '12px 14px', fontSize: 16, border: '1px solid #ddd',
  borderRadius: 10, boxSizing: 'border-box', fontFamily: 'inherit',
}
const btn: React.CSSProperties = { padding: 12, fontSize: 15, borderRadius: 10, border: 0, background: '#111', color: '#fff' }

export default function ShopSheet({ flipbookId, session, products, orderOn, initialId, onClose }: Props) {
  const [cart, setCart] = useState<Record<string, number>>(() => (initialId ? { [initialId]: 1 } : {}))
  const [choice, setChoice] = useState<Record<string, string>>({})
  const [delivery, setDelivery] = useState('')
  const [step, setStep] = useState<'items' | 'form' | 'done'>('items')
  const [name, setName] = useState('')
  const [contact, setContact] = useState('')
  const [company, setCompany] = useState('')
  const [memo, setMemo] = useState('')
  const [agree, setAgree] = useState(false)
  const [marketing, setMarketing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const optionsOf = (p: ShopProduct) => (p.options ?? '').split(',').map((o) => o.trim()).filter(Boolean)
  const picked = products.filter((p) => (cart[p.id] ?? 0) > 0)
  const count = picked.reduce((s, p) => s + cart[p.id], 0)
  const allPriced = picked.every((p) => p.price !== null)
  const total = useMemo(() => picked.reduce((s, p) => s + (p.price ?? 0) * cart[p.id], 0), [picked, cart])

  const setQty = (id: string, qty: number) => {
    setCart((c) => {
      const next = { ...c }
      if (qty <= 0) delete next[id]
      else next[id] = Math.min(qty, 999)
      return next
    })
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!agree || busy) return
    setBusy(true)
    setError(null)
    const { error: err } = await createClient().rpc('submit_order', {
      p_flipbook: flipbookId,
      p_name: name,
      p_contact: contact,
      p_company: company,
      p_memo: memo,
      p_items: picked.map((p) => ({ product_id: p.id, qty: cart[p.id], option: choice[p.id] ?? null })),
      p_marketing: marketing,
      p_session: session,
      p_delivery: delivery || null,
    })
    setBusy(false)
    if (err) return setError(err.message || '보내지 못했어요. 잠시 후 다시 해 주세요.')
    setStep('done')
    fetch('/api/orders/notify', {
      method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flipbook_id: flipbookId, session }),
    }).catch(() => undefined)
    fetch('/api/webhooks/dispatch', { method: 'POST', keepalive: true }).catch(() => undefined)
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="shop-title"
      style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div style={{ width: '100%', maxWidth: 520, maxHeight: '88vh', overflowY: 'auto', background: '#fff', color: '#111', borderRadius: '16px 16px 0 0', padding: '18px 18px calc(20px + env(safe-area-inset-bottom))', boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <h2 id="shop-title" style={{ fontSize: 17, margin: 0 }}>{step === 'done' ? '주문 요청 완료' : step === 'form' ? '주문 정보' : '상품 고르기'}</h2>
          <button type="button" onClick={onClose} style={{ padding: '8px 12px', border: '1px solid #ddd', borderRadius: 8, background: '#fff' }}>닫기</button>
        </div>

        {step === 'done' && (
          <>
            <p style={{ fontSize: 14, color: '#555', margin: '12px 0 16px' }}>주문 요청을 보냈어요. 발행자가 확인한 뒤 연락드릴 거예요. 결제는 아직 이뤄지지 않아요.</p>
            <button type="button" onClick={onClose} style={{ ...btn, width: '100%' }}>계속 보기</button>
          </>
        )}

        {step === 'items' && (
          <>
            {products.length === 0 ? (
              <p style={{ fontSize: 14, color: '#777', marginTop: 12 }}>등록된 상품이 없어요.</p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0', display: 'grid', gap: 8 }}>
                {products.map((p) => {
                  const q = cart[p.id] ?? 0
                  return (
                    <li key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, borderBottom: '1px solid #eee', paddingBottom: 8 }}>
                      <div style={{ display: 'flex', gap: 10, minWidth: 0, alignItems: 'center', fontSize: 14 }}>
                        {p.image_url && <img src={p.image_url} alt="" width={56} height={56} loading="lazy" style={{ borderRadius: 8, objectFit: 'cover', flexShrink: 0 }} />}
                        <div style={{ minWidth: 0, fontSize: 14 }}>
                        <strong style={{ display: 'block' }}>{p.name}</strong>
                        <span style={{ color: '#777', fontSize: 12 }}>
                          {p.price !== null ? `${p.price.toLocaleString('ko-KR')}원` : '가격 문의'}{p.unit ? ` / ${p.unit}` : ''}
                        </span>
                        {optionsOf(p).length > 0 && (
                          <select value={choice[p.id] ?? optionsOf(p)[0]} onChange={(e) => setChoice((c) => ({ ...c, [p.id]: e.target.value }))}
                            style={{ display: 'block', marginTop: 4, padding: '6px 8px', fontSize: 13, borderRadius: 8, border: '1px solid #ddd' }}>
                            {optionsOf(p).map((o) => <option key={o} value={o}>{o}</option>)}
                          </select>
                        )}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <button type="button" onClick={() => setQty(p.id, q - 1)} disabled={q === 0} style={{ width: 36, height: 36, borderRadius: 8, border: '1px solid #ddd', background: '#fff' }}>−</button>
                        <span style={{ minWidth: 24, textAlign: 'center' }}>{q}</span>
                        <button type="button" onClick={() => setQty(p.id, q + 1)} style={{ width: 36, height: 36, borderRadius: 8, border: '1px solid #ddd', background: '#fff' }}>+</button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}

            <div style={{ marginTop: 14, background: '#1f1f1f', color: '#fff', borderRadius: 12, padding: '12px 14px', display: 'grid', gap: 6, fontSize: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Total items</span><strong>{count}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Total value</span>
                <strong>{count === 0 ? '-' : allPriced ? `${total.toLocaleString('ko-KR')}원` : '발행자가 확인해요'}</strong>
              </div>
            </div>

            {orderOn ? (
              <button type="button" onClick={() => setStep('form')} disabled={count === 0} style={{ ...btn, width: '100%', marginTop: 14, background: count === 0 ? '#bbb' : '#111' }}>
                견적 요청하기
              </button>
            ) : (
              <p style={{ fontSize: 12, color: '#777', marginTop: 12 }}>이 자료는 지금 주문 요청을 받지 않아요.</p>
            )}
          </>
        )}

        {step === 'form' && (
          <form onSubmit={submit} style={{ display: 'grid', gap: 12, marginTop: 12 }}>
            <label style={{ display: 'grid', gap: 6, fontSize: 13 }}>이름
              <input style={field} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} disabled={busy} />
            </label>
            <label style={{ display: 'grid', gap: 6, fontSize: 13 }}>연락처 (휴대폰 번호 또는 이메일)
              <input style={field} value={contact} onChange={(e) => setContact(e.target.value)} maxLength={120} inputMode="tel" disabled={busy} />
            </label>
            <label style={{ display: 'grid', gap: 6, fontSize: 13 }}>희망 납기일 (선택)
              <input type="date" style={field} value={delivery} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setDelivery(e.target.value)} disabled={busy} />
            </label>
            <label style={{ display: 'grid', gap: 6, fontSize: 13 }}>회사명 (선택)
              <input style={field} value={company} onChange={(e) => setCompany(e.target.value)} maxLength={60} disabled={busy} />
            </label>
            <label style={{ display: 'grid', gap: 6, fontSize: 13 }}>요청 메모 (선택)
              <textarea style={{ ...field, minHeight: 80, resize: 'vertical' }} value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={500} disabled={busy} />
            </label>
            <label style={{ display: 'flex', gap: 8, fontSize: 13, alignItems: 'flex-start' }}>
              <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} disabled={busy} style={{ marginTop: 3 }} />
              <span><strong>[필수]</strong> 이름과 연락처를 이 자료의 발행자에게 전달하는 데 동의해요. <Link href="/privacy" target="_blank" style={{ color: '#555' }}>개인정보 처리방침</Link></span>
            </label>
            <label style={{ display: 'flex', gap: 8, fontSize: 13, alignItems: 'flex-start' }}>
              <input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} disabled={busy} style={{ marginTop: 3 }} />
              <span><strong>[선택]</strong> 재구매 안내 등 소식 이메일을 받는 데 동의해요.</span>
            </label>
            {error && <div role="alert" style={{ fontSize: 13, color: '#c0392b' }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" onClick={() => setStep('items')} disabled={busy} style={{ ...btn, flex: 1, background: '#fff', color: '#333', border: '1px solid #ddd' }}>이전</button>
              <button type="submit" disabled={!agree || !name.trim() || !contact.trim() || busy} style={{ ...btn, flex: 1, background: agree && name.trim() && contact.trim() ? '#111' : '#bbb' }}>
                {busy ? '보내는 중...' : '견적 요청 보내기'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
