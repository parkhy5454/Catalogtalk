'use client'
// Owner's product screen: products of one catalog (AI reads them page by page, or added by hand),
// the order-request switch, and the reorder-reminder setting.
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

type Product = {
  id: string; name: string; price: number | null; unit: string | null; options: string | null; page_no: number | null
  description: string | null; image_url: string | null; bbox: number[] | null; visibility: string
}
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
  const [editPage, setEditPage] = useState('')
  const [editUrl, setEditUrl] = useState<string | null>(null)
  const [editTarget, setEditTarget] = useState('')
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const stopRef = useRef(false)
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)

  const load = useCallback(async () => {
    const [book, rows] = await Promise.all([
      supabase.from('flipbooks').select('title, page_count, order_form, reorder_days, order_requires_subscription').eq('id', id).maybeSingle(),
      supabase.from('catalog_products').select('id, name, price, unit, options, page_no, description, image_url, bbox, visibility').eq('flipbook_id', id).order('page_no', { ascending: true }).order('created_at', { ascending: true }),
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

  const cutPhoto = async (p: Product) => {
    if (!p.bbox || !p.page_no) return
    setNotice(null)
    try {
      const res = await fetch(`/api/products/page-image?flipbook_id=${id}&page_no=${p.page_no}`)
      const info = (await res.json().catch(() => ({}))) as { url?: string; error?: string }
      if (!res.ok || !info.url) throw new Error(info.error ?? '쪽 이미지를 읽지 못했어요')
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image()
        el.crossOrigin = 'anonymous'
        el.onload = () => resolve(el)
        el.onerror = () => reject(new Error('쪽 이미지를 읽지 못했어요'))
        el.src = info.url as string
      })
      const [x, y, w, h] = p.bbox
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(w * img.width))
      canvas.height = Math.max(1, Math.round(h * img.height))
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('사진을 자르지 못했어요')
      ctx.drawImage(img, x * img.width, y * img.height, w * img.width, h * img.height, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
      if (!blob) throw new Error('사진을 자르지 못했어요')
      const supabase = createClient()
      const path = `${id}/products/${p.id}.jpg`
      const up = await supabase.storage.from('flipbook-files').upload(path, blob, { contentType: 'image/jpeg', upsert: true })
      if (up.error) throw new Error('사진을 저장하지 못했어요')
      const publicUrl = supabase.storage.from('flipbook-files').getPublicUrl(path).data.publicUrl
      const { error: err } = await supabase.from('catalog_products').update({ image_url: `${publicUrl}?v=${Date.now()}` }).eq('id', p.id)
      if (err) throw new Error('사진 주소를 저장하지 못했어요')
      setNotice({ kind: 'success', text: `${p.name} 사진을 잘랐어요` })
      await load()
    } catch (e) {
      setNotice({ kind: 'error', text: e instanceof Error ? e.message : '사진을 자르지 못했어요' })
    }
  }

  const setVisibility = async (p: Product, visibility: string) => {
    const { error } = await createClient().from('catalog_products').update({ visibility }).eq('id', p.id)
    if (error) return setNotice({ kind: 'error', text: '공개 설정을 바꾸지 못했어요' })
    await load()
  }

  const writeDescription = async (p: Product) => {
    setNotice(null)
    const res = await fetch('/api/products/describe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ product_id: p.id }),
    })
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok) return setNotice({ kind: 'error', text: body.error ?? '설명을 쓰지 못했어요' })
    setNotice({ kind: 'success', text: `${p.name} 설명을 썼어요. 내용을 확인해 주세요.` })
    await load()
  }

  const openPage = async () => {
    const n = Number(editPage)
    if (!Number.isInteger(n) || n < 1) return setNotice({ kind: 'error', text: '쪽 번호를 확인해 주세요' })
    setNotice(null)
    setEditUrl(null)
    const res = await fetch(`/api/products/page-image?flipbook_id=${id}&page_no=${n}`)
    const info = (await res.json().catch(() => ({}))) as { url?: string; error?: string }
    if (!res.ok || !info.url) return setNotice({ kind: 'error', text: info.error ?? '쪽 이미지를 불러오지 못했어요' })
    setEditUrl(info.url)
  }

  // Maps a pointer position on the page image to 0..1 coordinates.
  const relPoint = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    }
  }

  const finishDrag = async () => {
    const d = drag
    setDrag(null)
    if (!d || !editTarget) return
    const x = Math.min(d.x0, d.x1)
    const y = Math.min(d.y0, d.y1)
    const w = Math.abs(d.x1 - d.x0)
    const h = Math.abs(d.y1 - d.y0)
    if (w < 0.02 || h < 0.02) return setNotice({ kind: 'error', text: '조금 더 크게 그려 주세요' })
    const box = [x, y, w, h].map((v) => Math.round(v * 10000) / 10000)
    const { error } = await createClient().from('catalog_products').update({ bbox: box, image_url: null }).eq('id', editTarget)
    if (error) return setNotice({ kind: 'error', text: '영역을 저장하지 못했어요' })
    setNotice({ kind: 'success', text: '영역을 저장했어요. 사진 자르기를 다시 눌러 주세요.' })
    await load()
  }

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
        <h2 className="panel-title" style={{ fontSize: 16 }}>신제품 카탈로그</h2>
        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>고른 상품으로 새 카탈로그를 자동으로 만들어요.</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          <Link href={`/dashboard/products/${id}/new-catalog`} className="btn btn-primary">신제품 카탈로그 만들기</Link>
          <Link href={`/dashboard/pricing/${id}`} className="btn btn-ghost">거래처 가격·할인 관리</Link>
        </div>
      </section>

      <section className="panel" style={{ marginTop: 16 }}>
        <h2 className="panel-title" style={{ fontSize: 16 }}>사진 위치 지정</h2>
        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
          쪽을 열고, 상품을 고른 뒤 사진이 있는 자리를 드래그해 주세요. 그 자리가 상품 사진이 돼요.
        </p>
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input className="input" inputMode="numeric" value={editPage} onChange={(e) => setEditPage(e.target.value.replace(/[^0-9]/g, ''))} placeholder="쪽 번호" style={{ width: 110 }} />
          <button type="button" className="btn btn-ghost" onClick={openPage} disabled={!editPage}>쪽 열기</button>
        </div>
        {editUrl && (
          <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
            <select className="input" value={editTarget} onChange={(e) => setEditTarget(e.target.value)}>
              <option value="">상품 고르기</option>
              {(products ?? []).filter((p) => p.page_no === Number(editPage)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <div
              onPointerDown={(e) => {
                if (!editTarget) return setNotice({ kind: 'error', text: '먼저 상품을 골라 주세요' })
                e.currentTarget.setPointerCapture(e.pointerId)
                const pt = relPoint(e)
                setDrag({ x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y })
              }}
              onPointerMove={(e) => {
                if (!drag) return
                const pt = relPoint(e)
                setDrag({ ...drag, x1: pt.x, y1: pt.y })
              }}
              onPointerUp={() => { void finishDrag() }}
              style={{ position: 'relative', touchAction: 'none', userSelect: 'none', borderRadius: 8, overflow: 'hidden' }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={editUrl} alt="" draggable={false} style={{ width: '100%', display: 'block' }} />
              {(products ?? []).filter((p) => p.page_no === Number(editPage) && p.bbox).map((p) => (
                <div key={p.id} style={{
                  position: 'absolute', pointerEvents: 'none', border: '2px solid #1f9d7a', background: 'rgba(31,157,122,0.12)',
                  left: `${(p.bbox as number[])[0] * 100}%`, top: `${(p.bbox as number[])[1] * 100}%`,
                  width: `${(p.bbox as number[])[2] * 100}%`, height: `${(p.bbox as number[])[3] * 100}%`,
                }} />
              ))}
              {drag && (
                <div style={{
                  position: 'absolute', pointerEvents: 'none', border: '2px dashed #c0392b',
                  left: `${Math.min(drag.x0, drag.x1) * 100}%`, top: `${Math.min(drag.y0, drag.y1) * 100}%`,
                  width: `${Math.abs(drag.x1 - drag.x0) * 100}%`, height: `${Math.abs(drag.y1 - drag.y0) * 100}%`,
                }} />
              )}
            </div>
          </div>
        )}
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
                <div style={{ display: 'flex', gap: 8, minWidth: 0, alignItems: 'center' }}>
                  {p.image_url && <img src={p.image_url} alt="" width={44} height={44} style={{ borderRadius: 6, objectFit: 'cover', flexShrink: 0 }} />}
                  <div style={{ minWidth: 0 }}>
                    <strong className="truncate" style={{ display: 'block' }}>{p.name}</strong>
                    <span style={{ color: 'var(--muted)' }}>
                      {won(p.price)}{p.unit ? ` / ${p.unit}` : ''}{p.options ? ` · ${p.options}` : ''}{p.page_no ? ` · ${p.page_no}쪽` : ''}
                    </span>
                    {p.description && <span style={{ display: 'block', color: 'var(--muted)', fontSize: 12 }}>{p.description}</span>}
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
                  <select className="input" value={p.visibility} onChange={(e) => setVisibility(p, e.target.value)} style={{ fontSize: 12, padding: '4px 6px' }}>
                    <option value="all">모두에게 공개</option>
                    <option value="restricted">고객 전용</option>
                  </select>
                  {p.bbox && !p.image_url && <button type="button" className="btn btn-ghost" onClick={() => cutPhoto(p)}>사진 자르기</button>}
                  {!p.description && <button type="button" className="btn btn-ghost" onClick={() => writeDescription(p)}>설명 쓰기</button>}
                  <button type="button" className="btn btn-ghost" onClick={() => remove(p)}>삭제</button>
                </div>
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
