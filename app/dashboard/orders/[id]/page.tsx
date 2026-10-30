'use client'
// Owner's inbox of order requests for one catalog. Requests are not paid; the owner confirms them.
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

type Item = { name: string; price: number | null; unit: string | null; options: string | null; qty: number }
type Order = {
  id: string
  buyer_name: string
  buyer_contact: string
  buyer_company: string | null
  memo: string | null
  items: Item[]
  total: number | null
  status: 'new' | 'done'
  marketing_consent: boolean
  created_at: string
}

const won = (n: number) => `${n.toLocaleString('ko-KR')}원`

export default function OrdersPage() {
  const { id } = useParams<{ id: string }>()
  const supabase = createClient()
  const [title, setTitle] = useState('')
  const [rows, setRows] = useState<Order[] | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [book, orders] = await Promise.all([
      supabase.from('flipbooks').select('title').eq('id', id).maybeSingle(),
      supabase
        .from('orders')
        .select('id, buyer_name, buyer_contact, buyer_company, memo, items, total, status, marketing_consent, created_at')
        .eq('flipbook_id', id)
        .order('created_at', { ascending: false })
        .limit(500),
    ])
    if (!book.data) return setNotFound(true)
    setTitle(book.data.title)
    if (orders.error) setError('목록을 불러오지 못했어요')
    else setRows((orders.data as Order[]) ?? [])
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const toggle = async (o: Order) => {
    const next = o.status === 'new' ? 'done' : 'new'
    const { error: err } = await supabase.from('orders').update({ status: next }).eq('id', o.id)
    if (err) return setError('상태를 바꾸지 못했어요')
    setRows((prev) => (prev ? prev.map((x) => (x.id === o.id ? { ...x, status: next } : x)) : prev))
  }

  const remove = async (oid: string) => {
    if (!window.confirm('이 주문 요청을 삭제할까요? 되돌릴 수 없어요.')) return
    const { error: err } = await supabase.from('orders').delete().eq('id', oid)
    if (err) return setError('삭제하지 못했어요')
    setRows((prev) => (prev ? prev.filter((x) => x.id !== oid) : prev))
  }

  if (notFound) {
    return (
      <main className="container section">
        <div className="notice notice-error">자료를 찾을 수 없어요.</div>
        <Link href="/dashboard" className="btn btn-ghost btn-block" style={{ marginTop: 16 }}>대시보드로 돌아가기</Link>
      </main>
    )
  }

  const open = rows?.filter((r) => r.status === 'new').length ?? 0

  return (
    <main className="container section">
      <Link href={`/dashboard/products/${id}`} className="btn btn-ghost" style={{ marginBottom: 12 }}>← 상품·주문</Link>
      <section className="panel">
        <div className="panel-head">
          <h1 className="panel-title" style={{ wordBreak: 'keep-all' }}>{title} 주문 요청</h1>
        </div>
        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
          확인하지 않은 요청 {open}건. 결제는 아직 없어요. 요청은 1년이 지나면 자동 삭제돼요.
        </p>

        {error && <div className="notice notice-error" role="alert" style={{ marginTop: 12 }}>{error}</div>}

        {rows === null ? (
          <div className="skeleton" style={{ height: 120, marginTop: 12 }} aria-hidden="true" />
        ) : rows.length === 0 ? (
          <div className="notice notice-info" style={{ marginTop: 12 }}>아직 주문 요청이 없어요.</div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0', display: 'grid', gap: 8 }}>
            {rows.map((o) => (
              <li key={o.id} className="info-box" style={{ display: 'grid', gap: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                  <strong className="truncate">{o.buyer_company ? `${o.buyer_company} · ` : ''}{o.buyer_name}</strong>
                  <span style={{ fontSize: 12, color: o.status === 'new' ? '#c0392b' : 'var(--muted)', whiteSpace: 'nowrap' }}>
                    {o.status === 'new' ? '확인 전' : '확인 완료'}
                  </span>
                </div>
                <span style={{ fontSize: 13 }}>{o.buyer_contact}{o.marketing_consent ? ' · 소식 동의' : ''}</span>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                  {o.items.map((it, i) => (
                    <li key={i}>
                      {it.name} × {it.qty}{it.options ? ` (${it.options})` : ''}
                      {it.price !== null ? ` · ${won(it.price * it.qty)}` : ' · 가격 문의'}
                    </li>
                  ))}
                </ul>
                <span style={{ fontSize: 13 }}>합계: {o.total === null ? '가격 확인 필요' : won(o.total)}</span>
                {o.memo && <p style={{ fontSize: 13, margin: 0, whiteSpace: 'pre-wrap' }}>{o.memo}</p>}
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{new Date(o.created_at).toLocaleString('ko-KR')}</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" className="btn btn-ghost" onClick={() => toggle(o)}>
                    {o.status === 'new' ? '확인 완료로 표시' : '확인 전으로 되돌리기'}
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => remove(o.id)}>삭제</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
