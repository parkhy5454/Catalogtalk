'use client'
// QR codes for one catalog. Each code links to the catalog (optionally to a page or product),
// and the stats show visits and inquiries that came through that code.
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import QRCode from 'qrcode'
import { createClient } from '@/lib/supabase/client'
import { SITE_URL } from '@/lib/site'

type Stat = { qr_id: string; qr_code: string; qr_label: string; qr_page: number | null; qr_product: string | null; visitors: number; leads: number; quotes: number; orders: number }
type Product = { id: string; name: string; page_no: number | null }

function newCode(): string {
  // Tracking code, not a secret: 10 random hex characters.
  return crypto.randomUUID().replace(/-/g, '').slice(0, 10)
}

export default function QrPage() {
  const { id } = useParams<{ id: string }>()
  const [slug, setSlug] = useState('')
  const [title, setTitle] = useState('')
  const [notFound, setNotFound] = useState(false)
  const [stats, setStats] = useState<Stat[] | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [images, setImages] = useState<Record<string, string>>({})
  const [label, setLabel] = useState('')
  const [productId, setProductId] = useState('')
  const [page, setPage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const supabase = createClient()
    const [book, st, prods] = await Promise.all([
      supabase.from('flipbooks').select('title, slug').eq('id', id).maybeSingle(),
      supabase.rpc('get_qr_stats', { p_flipbook: id }),
      supabase.from('catalog_products').select('id, name, page_no').eq('flipbook_id', id).order('page_no', { ascending: true }),
    ])
    if (!book.data) return setNotFound(true)
    setTitle(book.data.title)
    setSlug(book.data.slug)
    if (st.error) return setError('목록을 불러오지 못했어요')
    setStats((st.data as Stat[]) ?? [])
    setProducts((prods.data as Product[]) ?? [])
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  // Draw each QR image for its link.
  useEffect(() => {
    if (!stats || !slug) return
    let cancelled = false
    ;(async () => {
      const next: Record<string, string> = {}
      for (const s of stats) {
        next[s.qr_id] = await QRCode.toDataURL(linkFor(slug, s.qr_code, s.qr_page), { margin: 1, width: 240 })
      }
      if (!cancelled) setImages(next)
    })()
    return () => {
      cancelled = true
    }
  }, [stats, slug])

  const pickProduct = (pid: string) => {
    setProductId(pid)
    const p = products.find((x) => x.id === pid)
    if (p?.page_no) setPage(String(p.page_no))
  }

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    const name = label.trim()
    if (!name || busy) return
    const pageNo = page ? Number(page) : null
    if (pageNo !== null && (!Number.isInteger(pageNo) || pageNo < 1)) return setError('쪽 번호를 확인해 주세요')
    setBusy(true)
    setError(null)
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      setBusy(false)
      return setError('로그인이 필요해요')
    }
    const { error: err } = await supabase.from('qr_codes').insert({
      flipbook_id: id,
      owner_id: user.id,
      code: newCode(),
      label: name,
      page_no: pageNo,
      product_id: productId || null,
    })
    setBusy(false)
    if (err) return setError('QR을 만들지 못했어요. 쪽 번호가 맞는지 확인해 주세요.')
    setLabel('')
    setProductId('')
    setPage('')
    await load()
  }

  const remove = async (qrId: string) => {
    if (!window.confirm('이 QR을 삭제할까요? 이미 찍힌 QR은 연결이 끊겨요.')) return
    const { error: err } = await createClient().from('qr_codes').delete().eq('id', qrId)
    if (err) return setError('삭제하지 못했어요')
    await load()
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      /* clipboard can be blocked; the link stays visible */
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

  return (
    <main className="container section">
      <Link href={`/dashboard/stats/${id}`} className="btn btn-ghost" style={{ marginBottom: 12 }}>← 통계</Link>
      <h1 className="panel-title" style={{ wordBreak: 'keep-all' }}>{title} · QR 코드</h1>
      <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
        전시회 부스, 매장, 명함에 넣은 QR로 들어온 방문과 문의를 따로 세어요.
      </p>

      {error && <div className="notice notice-error" role="alert" style={{ marginTop: 12 }}>{error}</div>}

      <section className="panel" style={{ marginTop: 14 }}>
        <h2 className="panel-title" style={{ fontSize: 16 }}>새 QR 만들기</h2>
        <form onSubmit={create} style={{ display: 'grid', gap: 10, marginTop: 10 }}>
          <label className="field">
            <span className="field-label">이름 (예: 2026 서울 전시회 부스)</span>
            <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} disabled={busy} />
          </label>
          <label className="field">
            <span className="field-label">상품 (선택)</span>
            <select className="input" value={productId} onChange={(e) => pickProduct(e.target.value)} disabled={busy}>
              <option value="">상품 없이 카탈로그 처음으로</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}{p.page_no ? ` (${p.page_no}쪽)` : ''}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field-label">열 쪽 번호 (선택)</span>
            <input className="input" inputMode="numeric" value={page} onChange={(e) => setPage(e.target.value.replace(/[^0-9]/g, ''))} disabled={busy} />
          </label>
          <button type="submit" className="btn btn-primary" disabled={!label.trim() || busy}>
            {busy ? '만드는 중...' : 'QR 만들기'}
          </button>
        </form>
      </section>

      <section style={{ marginTop: 16, display: 'grid', gap: 10 }}>
        {stats === null ? (
          <div className="skeleton" style={{ height: 120 }} aria-hidden="true" />
        ) : stats.length === 0 ? (
          <div className="notice notice-info">아직 만든 QR이 없어요.</div>
        ) : (
          stats.map((s) => {
            const link = linkFor(slug, s.qr_code, s.qr_page)
            return (
              <article key={s.qr_id} className="panel" style={{ display: 'grid', gap: 10 }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  {images[s.qr_id] ? (
                    <img src={images[s.qr_id]} alt={`${s.qr_label} QR`} width={120} height={120} style={{ borderRadius: 8, background: '#fff' }} />
                  ) : (
                    <div className="skeleton" style={{ width: 120, height: 120 }} aria-hidden="true" />
                  )}
                  <div style={{ minWidth: 0, display: 'grid', gap: 4 }}>
                    <strong className="truncate">{s.qr_label}</strong>
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {s.qr_product ? `상품: ${s.qr_product}` : '상품 없음'}{s.qr_page ? ` · ${s.qr_page}쪽` : ''}
                    </span>
                    <span style={{ fontSize: 13 }}>방문 {s.visitors}명 · 문의 {s.leads} · 견적 {s.quotes} · 주문 {s.orders}</span>
                  </div>
                </div>
                <code style={{ fontSize: 11, wordBreak: 'break-all', color: 'var(--muted)' }}>{link}</code>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button type="button" className="btn btn-ghost" onClick={() => copy(link)}>링크 복사</button>
                  {images[s.qr_id] && (
                    <a className="btn btn-ghost" href={images[s.qr_id]} download={`qr-${s.qr_code}.png`}>QR 이미지 저장</a>
                  )}
                  <button type="button" className="btn btn-ghost" onClick={() => remove(s.qr_id)}>삭제</button>
                </div>
              </article>
            )
          })
        )}
      </section>
    </main>
  )
}

function linkFor(slug: string, code: string, page: number | null): string {
  const base = `${SITE_URL}/b/${slug}?q=${code}`
  return page ? `${base}&page=${page}` : base
}
