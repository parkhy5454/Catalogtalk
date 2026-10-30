'use client'
// Printable order sheet for one request. Use the browser's print dialog to save it as PDF.
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

type Item = { name: string; price: number | null; unit: string | null; option?: string | null; qty: number }
type Order = {
  id: string
  buyer_name: string
  buyer_contact: string
  buyer_company: string | null
  memo: string | null
  items: Item[]
  total: number | null
  delivery_date: string | null
  created_at: string
}

const won = (n: number) => `${n.toLocaleString('ko-KR')}원`

export default function OrderSheetPage() {
  const { id, orderId } = useParams<{ id: string; orderId: string }>()
  const [order, setOrder] = useState<Order | null>(null)
  const [title, setTitle] = useState('')
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    const supabase = createClient()
    ;(async () => {
      const [book, row] = await Promise.all([
        supabase.from('flipbooks').select('title').eq('id', id).maybeSingle(),
        supabase
          .from('orders')
          .select('id, buyer_name, buyer_contact, buyer_company, memo, items, total, delivery_date, created_at')
          .eq('id', orderId)
          .eq('flipbook_id', id)
          .maybeSingle(),
      ])
      if (!row.data) return setMissing(true)
      setTitle(book.data?.title ?? '')
      setOrder(row.data as Order)
    })()
  }, [id, orderId])

  if (missing) {
    return (
      <main className="container section">
        <div className="notice notice-error">주문을 찾을 수 없어요.</div>
        <Link href={`/dashboard/orders/${id}`} className="btn btn-ghost btn-block" style={{ marginTop: 16 }}>주문 목록으로</Link>
      </main>
    )
  }
  if (!order) return <main className="container section"><div className="skeleton" style={{ height: 240 }} aria-hidden="true" /></main>

  const sum = order.items.reduce((s, i) => s + (i.price ?? 0) * i.qty, 0)
  const priced = order.items.every((i) => i.price !== null)

  return (
    <main className="container section order-sheet">
      <style>{`@media print { .no-print { display: none !important; } body { background: #fff; } }`}</style>
      <div className="no-print" style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <Link href={`/dashboard/orders/${id}`} className="btn btn-ghost">← 주문 목록</Link>
        <button type="button" className="btn btn-primary" onClick={() => window.print()}>인쇄 · PDF로 저장</button>
      </div>

      <article style={{ background: '#fff', color: '#111', padding: 24, borderRadius: 12, border: '1px solid #ddd' }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>주문서</h1>
        <p style={{ fontSize: 13, color: '#555', margin: '4px 0 16px' }}>{title} · 주문번호 {order.id.slice(0, 8).toUpperCase()}</p>

        <table style={{ width: '100%', fontSize: 14, borderCollapse: 'collapse', marginBottom: 16 }}>
          <tbody>
            <tr><th style={{ textAlign: 'left', width: 96, padding: '4px 0' }}>구매자</th><td>{order.buyer_company ? `${order.buyer_company} · ` : ''}{order.buyer_name}</td></tr>
            <tr><th style={{ textAlign: 'left', padding: '4px 0' }}>연락처</th><td>{order.buyer_contact}</td></tr>
            <tr><th style={{ textAlign: 'left', padding: '4px 0' }}>요청일</th><td>{new Date(order.created_at).toLocaleDateString('ko-KR')}</td></tr>
            <tr><th style={{ textAlign: 'left', padding: '4px 0' }}>희망 납기</th><td>{order.delivery_date ?? '미정'}</td></tr>
          </tbody>
        </table>

        <table style={{ width: '100%', fontSize: 14, borderCollapse: 'collapse', borderTop: '1px solid #ddd' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>
              <th style={{ padding: '6px 0' }}>상품</th><th>옵션</th><th style={{ textAlign: 'right' }}>수량</th><th style={{ textAlign: 'right' }}>금액</th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((i, n) => (
              <tr key={n} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: '6px 0' }}>{i.name}</td>
                <td>{i.option ?? '-'}</td>
                <td style={{ textAlign: 'right' }}>{i.qty}{i.unit ? ` ${i.unit}` : ''}</td>
                <td style={{ textAlign: 'right' }}>{i.price === null ? '문의' : won(i.price * i.qty)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td colSpan={3} style={{ textAlign: 'right', padding: '8px 0', fontWeight: 700 }}>합계</td>
              <td style={{ textAlign: 'right', fontWeight: 700 }}>{priced ? won(sum) : '가격 확인 필요'}</td></tr>
          </tfoot>
        </table>

        {order.memo && <p style={{ fontSize: 13, marginTop: 16, whiteSpace: 'pre-wrap' }}><strong>요청 메모</strong><br />{order.memo}</p>}
        <p style={{ fontSize: 12, color: '#777', marginTop: 20 }}>이 주문서는 요청 내용을 정리한 것이며, 결제 문서가 아니에요.</p>
      </article>
    </main>
  )
}
