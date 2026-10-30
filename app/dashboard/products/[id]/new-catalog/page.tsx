'use client'
// Makes a new catalog from chosen products: pick products, give a title, and the pages are drawn for you.
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { createCatalogFromProducts, MAX_PRODUCTS_PER_NEW_CATALOG, type CatalogProduct } from '@/lib/flipbook/product-catalog'

type Row = CatalogProduct & { id: string; page_no: number | null }

export default function NewCatalogPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [title, setTitle] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const supabase = createClient()
    ;(async () => {
      const [book, prods] = await Promise.all([
        supabase.from('flipbooks').select('title').eq('id', id).maybeSingle(),
        supabase.from('catalog_products').select('id, name, price, unit, options, description, image_url, page_no').eq('flipbook_id', id).order('page_no', { ascending: true }).order('created_at', { ascending: true }),
      ])
      const list = (prods.data as Row[]) ?? []
      setRows(list)
      setPicked(new Set(list.map((p) => p.id)))
      setTitle(`신제품 카탈로그 ${new Date().toLocaleDateString('ko-KR')}`)
      if (!book.data) setError('자료를 찾을 수 없어요')
    })()
  }, [id])

  const toggle = (pid: string) => {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(pid)) next.delete(pid)
      else next.add(pid)
      return next
    })
  }

  const make = async () => {
    if (busy) return
    const chosen = (rows ?? []).filter((r) => picked.has(r.id))
    if (chosen.length === 0) return setError('상품을 하나 이상 골라 주세요')
    if (!title.trim()) return setError('카탈로그 이름을 적어 주세요')
    setBusy(true)
    setError(null)
    try {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('로그인이 필요해요')
      const fb = await createCatalogFromProducts(
        supabase,
        { userId: user.id, title: title.trim().slice(0, 120), products: chosen },
        (text) => setStatus(text)
      )
      router.push(`/dashboard/stats/${fb.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : '카탈로그를 만들지 못했어요')
      setStatus(null)
      setBusy(false)
    }
  }

  return (
    <main className="container section">
      <Link href={`/dashboard/products/${id}`} className="btn btn-ghost" style={{ marginBottom: 12 }}>← 상품 관리</Link>
      <section className="panel">
        <h1 className="panel-title">신제품 카탈로그 만들기</h1>
        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
          고른 상품으로 새 카탈로그를 만들어요. 한 쪽에 6개씩 들어가고, 사진·이름·가격·옵션·설명이 실려요.
          최대 {MAX_PRODUCTS_PER_NEW_CATALOG}개까지예요.
        </p>

        {error && <div className="notice notice-error" role="alert" style={{ marginTop: 12 }}>{error}</div>}

        <label className="field" style={{ marginTop: 12 }}>
          <span className="field-label">카탈로그 이름</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} disabled={busy} />
        </label>

        {rows === null ? (
          <div className="skeleton" style={{ height: 120, marginTop: 12 }} aria-hidden="true" />
        ) : rows.length === 0 ? (
          <div className="notice notice-info" style={{ marginTop: 12 }}>상품이 없어요. 먼저 상품을 등록해 주세요.</div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0', display: 'grid', gap: 6 }}>
            {rows.map((r) => (
              <li key={r.id}>
                <label className="info-box" style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 13 }}>
                  <input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(r.id)} disabled={busy} />
                  {r.image_url && <img src={r.image_url} alt="" width={40} height={40} style={{ borderRadius: 6, objectFit: 'cover' }} />}
                  <span style={{ minWidth: 0 }}>
                    <strong className="truncate" style={{ display: 'block' }}>{r.name}</strong>
                    <span style={{ color: 'var(--muted)' }}>{r.price === null ? '가격 문의' : `${r.price.toLocaleString('ko-KR')}원`}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}

        {status && <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 12 }}>{status}</p>}
        <button type="button" className="btn btn-primary btn-block" style={{ marginTop: 14 }} onClick={make} disabled={busy || picked.size === 0}>
          {busy ? '만드는 중...' : `카탈로그 만들기 (${picked.size}개)`}
        </button>
      </section>
    </main>
  )
}
