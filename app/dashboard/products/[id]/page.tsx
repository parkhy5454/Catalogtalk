'use client'
// Owner's product screen: products of one catalog (AI reads them page by page, or added by hand),
// the order-request switch, and the reorder-reminder setting.
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

type Product = { id: string; name: string; price: number | null; unit: string | null; options: string | null; page_no: number | null }
const REMINDER_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: '끄기' },
  { value: '30', label: '30일 뒤' },
  { value: '60', label: '60일 뒤' },
  { value: '90', label: '90일 뒤' },
  { value: '180', label: '180일 뒤' },
]
const won = (n: number | null) => (n === null ? '가격 미정' : `${n.toLocaleString('ko-KR')}원`)

export default function ProductsPage() {
  const { id } = useParams<{ id: string }>()
  const supabase = createClient()
  const [title, setTitle] = useState('')
  const [pageCount, setPageCount] = useState(0)
  const [notFound, setNotFound] = useState(false)
  const [orderOn, setOrderOn] = useState(false)
  const [reorder, setReorder] = useState('')
  const [subOnly, setSubOnly] = useState(false)
  const [products, setProducts] = useState<Product[] | null>(null)
  const [name, setName] = useState('')
  const [price, setPrice] = useState('')
  const [unit, setUnit] = useState('')
  const [options, setOptions] = useState('')
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState<{ done: number; total: number } | null>(null)
  const stopRef = useRef(false)
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)

  const load = useCallback(async () => {
    const [book, rows] = await Promise.all([
      supabase.from('flipbooks').select('title, page_count, order_form, reorder_days, order_requires_subscription').eq('id', id).maybeSingle(),
      supabase.from('catalog_products').select('id, name, price, unit, options, page_no').eq('flipbook_id', id).order('page_no', { ascending: true }).order('created_at', { ascending: true }),
    ])
    if (!book.data) return setNotFound(true)
    setTitle(book.data.title)
    setPageCount(book.data.page_count ?? 0)
    setOrderOn(book.data.order_form === true)
    setReorder(book.data.reorder_days ? String(book.data.reorder_days) : '')
    setSubOnly(book.data.order_requires_subscription === true)
    setProducts((rows.data as Product[]) ?? [])
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const saveSettings = async (patch: { order_form?: boolean; reorder_days?: number | null; order_requires_subscription?: boolean }) => {
    const { error } = await supabase.from('flipbooks').update(patch).eq('id', id)
    if (error) return setNotice({ kind: 'error', text: '저장하지 못했어요' })
    await load()
  }

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    const p = Math.round(Number(price.replace(/,/g, '')))
    if (!name.trim()) return setNotice({ kind: 'error', text: '상품명을 입력해 주세요' })
    setBusy(true)
    setNotice(null)
    const { error } = await supabase.from('catalog_products').insert({
      flipbook_id: id,
      name: name.trim(),
      price: price.trim() && Number.isFinite(p) ? p : null,
      unit: unit.trim() || null,
      options: options.trim() || null,
    })
    setBusy(false)
    if (error) return setNotice({ kind: 'error', text: '추가하지 못했어요' })
    setName(''); setPrice(''); setUnit(''); setOptions('')
    await load()
  }

  const remove = async (p: Product) => {
    if (!window.confirm(`"${p.name}"을(를) 지울까요?`)) return
    const { error } = await supabase.from('catalog_products').delete().eq('id', p.id)
    if (error) return setNotice({ kind: 'error', text: '지우지 못했어요' })
    await load()
  }

  // Reads every page that has no products yet, one request per page.
  const readAll = async () => {
    const readPages = new Set((products ?? []).map((p) => p.page_no).filter((n): n is number => n !== null))
    const todo: number[] = []
    for (let p = 1; p <= pageCount; p++) if (!readPages.has(p)) todo.push(p)
    if (todo.length === 0) return setNotice({ kind: 'success', text: '모든 쪽을 이미 읽었어요.' })
    setNotice(null)
    stopRef.current = false
    setReading({ done: 0, total: todo.length })
    let done = 0
    let failed = false
    for (const p of todo) {
      if (stopRef.current) break
      const res = await fetch('/api/products/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flipbook_id: id, page_no: p }),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        failed = true
        setNotice({ kind: 'error', text: `${p}쪽에서 멈췄어요: ${body.error ?? '읽지 못했어요'}` })
        break
      }
      done++
      setReading({ done, total: todo.length })
    }
    setReading(null)
    await load()
    if (!failed) setNotice({ kind: 'success', text: `${done}쪽을 읽었어요. 값이 맞는지 확인해 주세요.` })
  }

  if (notFound) {
    return (
      <main className="container section">
        <div className="notice notice-error">자료를 찾을 수 없어요.</div>
        <Link href="/dashboard/folders" className="btn btn-ghost btn-block" style={{ marginTop: 16 }}>My Book으로 돌아가기</Link>
      </main>
    )
  }

  return (
    <main className="container section">
      <Link href={`/dashboard/stats/${id}`} className="btn btn-ghost" style={{ marginBottom: 12 }}>← 통계</Link>

      <section className="panel">
        <div className="panel-head">
          <h1 className="panel-title" style={{ wordBreak: 'keep-all' }}>{title} 상품·주문</h1>
          <Link href={`/dashboard/orders/${id}`} className="btn btn-ghost">받은 주문</Link>
        </div>

        {notice && (
          <div className={`notice ${notice.kind === 'error' ? 'notice-error' : 'notice-success'}`} role="status" style={{ marginTop: 12 }}>{notice.text}</div>
        )}

        <div className="form-stack" style={{ marginTop: 12 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
            <input type="checkbox" checked={orderOn} onChange={(e) => saveSettings({ order_form: e.target.checked })} />
            열람 중 주문 요청 받기 (결제는 아직 없어요)
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
            <input type="checkbox" checked={subOnly} onChange={(e) => saveSettings({ order_requires_subscription: e.target.checked })} />
            주문은 구독자만 (구독 기능은 준비 중이에요)
          </label>
          <label className="field">
            <span className="field-label">재구매 알림 (한 번 주문한 분께, 마지막 주문 후)</span>
            <select className="input" value={reorder} onChange={(e) => saveSettings({ reorder_days: e.target.value ? Number(e.target.value) : null })}>
              {REMINDER_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <p style={{ fontSize: 12, color: 'var(--muted)' }}>재구매 알림은 주문할 때 마케팅 소식에 동의한 분께만 이메일로 가요.</p>
        </div>
      </section>

      <section className="panel" style={{ marginTop: 16 }}>
        <h2 className="panel-title" style={{ fontSize: 16 }}>상품 목록 ({products?.length ?? 0}개)</h2>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
          {reading ? (
            <button type="button" className="btn btn-ghost" onClick={() => { stopRef.current = true }}>
              읽는 중 {reading.done}/{reading.total} · 멈추기
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={readAll} disabled={pageCount === 0}>AI로 쪽마다 상품 읽기</button>
          )}
        </div>
        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>AI가 읽은 값은 틀릴 수 있어요. 가격과 상품명을 꼭 확인해 주세요.</p>

        {products === null ? (
          <div className="skeleton" style={{ height: 100, marginTop: 12 }} aria-hidden="true" />
        ) : products.length === 0 ? (
          <div className="notice notice-info" style={{ marginTop: 12 }}>아직 상품이 없어요. AI로 읽거나 아래에서 직접 추가해 주세요.</div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0', display: 'grid', gap: 6, fontSize: 13 }}>
            {products.map((p) => (
              <li key={p.id} className="info-box" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                <div style={{ minWidth: 0 }}>
                  <strong className="truncate" style={{ display: 'block' }}>{p.name}</strong>
                  <span style={{ color: 'var(--muted)' }}>
                    {won(p.price)}{p.unit ? ` / ${p.unit}` : ''}{p.options ? ` · ${p.options}` : ''}{p.page_no ? ` · ${p.page_no}쪽` : ''}
                  </span>
                </div>
                <button type="button" className="btn btn-ghost" onClick={() => remove(p)}>삭제</button>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={add} className="form-stack" style={{ marginTop: 16 }}>
          <h3 style={{ fontSize: 14, margin: 0 }}>직접 추가</h3>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="상품명" disabled={busy} />
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="input" value={price} onChange={(e) => setPrice(e.target.value)} inputMode="numeric" placeholder="가격 (원)" disabled={busy} style={{ flex: 1 }} />
            <input className="input" value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={20} placeholder="단위 (예: 개, 박스)" disabled={busy} style={{ flex: 1 }} />
          </div>
          <input className="input" value={options} onChange={(e) => setOptions(e.target.value)} maxLength={300} placeholder="옵션 (예: 색상 3종, 사이즈 S·M·L)" disabled={busy} />
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>추가</button>
        </form>
      </section>
    </main>
  )
}
