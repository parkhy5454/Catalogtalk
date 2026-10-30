'use client'
// Price tiers (discount per buyer group), per-product tier prices, and promotions for one catalog.
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

type Tier = { id: string; name: string; discount_pct: number }
type Prod = { id: string; name: string; price: number | null }
type Override = { product_id: string; tier_id: string; price: number }
type Promo = { id: string; name: string; discount_pct: number; starts_at: string | null; ends_at: string | null; product_id: string | null; tier_id: string | null; active: boolean }

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('ko-KR') : '')

export default function PricingPage() {
  const { id } = useParams<{ id: string }>()
  const [title, setTitle] = useState('')
  const [notFound, setNotFound] = useState(false)
  const [tiers, setTiers] = useState<Tier[]>([])
  const [prods, setProds] = useState<Prod[]>([])
  const [overrides, setOverrides] = useState<Override[]>([])
  const [promos, setPromos] = useState<Promo[]>([])
  const [error, setError] = useState<string | null>(null)

  const [tierName, setTierName] = useState('')
  const [tierPct, setTierPct] = useState('0')
  const [ovProduct, setOvProduct] = useState('')
  const [ovTier, setOvTier] = useState('')
  const [ovPrice, setOvPrice] = useState('')
  const [pName, setPName] = useState('')
  const [pPct, setPPct] = useState('')
  const [pProduct, setPProduct] = useState('')
  const [pTier, setPTier] = useState('')
  const [pStart, setPStart] = useState('')
  const [pEnd, setPEnd] = useState('')

  const load = useCallback(async () => {
    const supabase = createClient()
    const [book, t, p, o, pr] = await Promise.all([
      supabase.from('flipbooks').select('title').eq('id', id).maybeSingle(),
      supabase.from('price_tiers').select('id, name, discount_pct').eq('flipbook_id', id).order('created_at'),
      supabase.from('catalog_products').select('id, name, price').eq('flipbook_id', id).order('page_no', { ascending: true }),
      supabase.from('product_tier_prices').select('product_id, tier_id, price').eq('flipbook_id', id),
      supabase.from('promotions').select('id, name, discount_pct, starts_at, ends_at, product_id, tier_id, active').eq('flipbook_id', id).order('created_at', { ascending: false }),
    ])
    if (!book.data) return setNotFound(true)
    setTitle(book.data.title)
    setTiers((t.data as Tier[]) ?? [])
    setProds((p.data as Prod[]) ?? [])
    setOverrides((o.data as Override[]) ?? [])
    setPromos((pr.data as Promo[]) ?? [])
    if (t.error || p.error || o.error || pr.error) setError('일부 목록을 불러오지 못했어요')
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const addTier = async (e: React.FormEvent) => {
    e.preventDefault()
    const pct = Number(tierPct)
    if (!tierName.trim() || !Number.isInteger(pct) || pct < 0 || pct > 90) return setError('등급 이름과 할인율(0~90%)을 확인해 주세요')
    const { error: err } = await createClient().from('price_tiers').insert({ flipbook_id: id, name: tierName.trim(), discount_pct: pct })
    if (err) return setError('등급을 추가하지 못했어요')
    setTierName('')
    setTierPct('0')
    setError(null)
    await load()
  }

  const removeTier = async (tid: string) => {
    if (!window.confirm('이 등급을 지울까요? 이 등급을 쓰던 고객은 일반 가격을 봐요.')) return
    const { error: err } = await createClient().from('price_tiers').delete().eq('id', tid)
    if (err) return setError('등급을 지우지 못했어요')
    await load()
  }

  const addOverride = async (e: React.FormEvent) => {
    e.preventDefault()
    const price = Number(ovPrice.replace(/[^0-9]/g, ''))
    if (!ovProduct || !ovTier || !Number.isFinite(price) || ovPrice === '') return setError('상품, 등급, 가격을 골라 주세요')
    const { error: err } = await createClient().from('product_tier_prices').upsert(
      { flipbook_id: id, product_id: ovProduct, tier_id: ovTier, price }, { onConflict: 'product_id,tier_id' })
    if (err) return setError('가격을 저장하지 못했어요')
    setOvPrice('')
    setError(null)
    await load()
  }

  const removeOverride = async (o: Override) => {
    const { error: err } = await createClient().from('product_tier_prices').delete().eq('product_id', o.product_id).eq('tier_id', o.tier_id)
    if (err) return setError('지우지 못했어요')
    await load()
  }

  const addPromo = async (e: React.FormEvent) => {
    e.preventDefault()
    const pct = Number(pPct)
    if (!pName.trim() || !Number.isInteger(pct) || pct < 1 || pct > 90) return setError('프로모션 이름과 할인율(1~90%)을 확인해 주세요')
    const { error: err } = await createClient().from('promotions').insert({
      flipbook_id: id,
      name: pName.trim(),
      discount_pct: pct,
      product_id: pProduct || null,
      tier_id: pTier || null,
      starts_at: pStart ? new Date(`${pStart}T00:00:00`).toISOString() : null,
      ends_at: pEnd ? new Date(`${pEnd}T23:59:59`).toISOString() : null,
    })
    if (err) return setError('프로모션을 추가하지 못했어요')
    setPName(''); setPPct(''); setPProduct(''); setPTier(''); setPStart(''); setPEnd('')
    setError(null)
    await load()
  }

  const togglePromo = async (p: Promo) => {
    const { error: err } = await createClient().from('promotions').update({ active: !p.active }).eq('id', p.id)
    if (err) return setError('바꾸지 못했어요')
    await load()
  }

  const removePromo = async (pid: string) => {
    const { error: err } = await createClient().from('promotions').delete().eq('id', pid)
    if (err) return setError('지우지 못했어요')
    await load()
  }

  const prodName = (pid: string | null) => (pid ? prods.find((x) => x.id === pid)?.name ?? '상품' : '모든 상품')
  const tierNameOf = (tid: string | null) => (tid ? tiers.find((x) => x.id === tid)?.name ?? '등급' : '모든 고객')

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
      <Link href={`/dashboard/products/${id}`} className="btn btn-ghost" style={{ marginBottom: 12 }}>← 상품 관리</Link>
      <h1 className="panel-title" style={{ wordBreak: 'keep-all' }}>{title} · 가격·할인</h1>
      <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
        등급별 할인, 상품별 등급 가격, 기간 프로모션을 설정해요. 할인은 여러 개를 더하지 않고 가장 큰 할인 하나만 적용돼요.
      </p>
      {error && <div className="notice notice-error" role="alert" style={{ marginTop: 12 }}>{error}</div>}

      <section className="panel" style={{ marginTop: 14 }}>
        <h2 className="panel-title" style={{ fontSize: 16 }}>거래처 등급</h2>
        <form onSubmit={addTier} style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <input className="input" value={tierName} onChange={(e) => setTierName(e.target.value)} maxLength={40} placeholder="등급 이름 (예: 도매)" style={{ flex: 2, minWidth: 120 }} />
          <input className="input" value={tierPct} onChange={(e) => setTierPct(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" placeholder="할인 %" style={{ width: 90 }} />
          <button type="submit" className="btn btn-primary" disabled={!tierName.trim()}>추가</button>
        </form>
        {tiers.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 10 }}>아직 등급이 없어요.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: '10px 0 0', display: 'grid', gap: 6, fontSize: 13 }}>
            {tiers.map((t) => (
              <li key={t.id} className="info-box" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <span>{t.name} · {t.discount_pct}% 할인</span>
                <button type="button" className="btn btn-ghost" onClick={() => removeTier(t.id)}>삭제</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel" style={{ marginTop: 16 }}>
        <h2 className="panel-title" style={{ fontSize: 16 }}>등급별 상품 가격</h2>
        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>지정하지 않으면 상품 가격에서 등급 할인을 적용해요.</p>
        <form onSubmit={addOverride} style={{ display: 'grid', gap: 8, marginTop: 10 }}>
          <select className="input" value={ovProduct} onChange={(e) => setOvProduct(e.target.value)}>
            <option value="">상품 고르기</option>
            {prods.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select className="input" value={ovTier} onChange={(e) => setOvTier(e.target.value)}>
            <option value="">등급 고르기</option>
            {tiers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <input className="input" value={ovPrice} onChange={(e) => setOvPrice(e.target.value)} inputMode="numeric" placeholder="이 등급 가격 (원)" />
          <button type="submit" className="btn btn-primary">저장</button>
        </form>
        {overrides.length > 0 && (
          <ul style={{ listStyle: 'none', padding: 0, margin: '10px 0 0', display: 'grid', gap: 6, fontSize: 13 }}>
            {overrides.map((o) => (
              <li key={`${o.product_id}-${o.tier_id}`} className="info-box" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <span>{prodName(o.product_id)} · {tierNameOf(o.tier_id)} · {o.price.toLocaleString('ko-KR')}원</span>
                <button type="button" className="btn btn-ghost" onClick={() => removeOverride(o)}>삭제</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel" style={{ marginTop: 16 }}>
        <h2 className="panel-title" style={{ fontSize: 16 }}>프로모션</h2>
        <form onSubmit={addPromo} style={{ display: 'grid', gap: 8, marginTop: 10 }}>
          <input className="input" value={pName} onChange={(e) => setPName(e.target.value)} maxLength={60} placeholder="이름 (예: 연말 세일)" />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input className="input" value={pPct} onChange={(e) => setPPct(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" placeholder="할인 %" style={{ width: 100 }} />
            <select className="input" value={pProduct} onChange={(e) => setPProduct(e.target.value)} style={{ flex: 1, minWidth: 120 }}>
              <option value="">모든 상품</option>
              {prods.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <select className="input" value={pTier} onChange={(e) => setPTier(e.target.value)} style={{ flex: 1, minWidth: 120 }}>
              <option value="">모든 고객</option>
              {tiers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 13 }}>
            <label>시작 <input className="input" type="date" value={pStart} onChange={(e) => setPStart(e.target.value)} /></label>
            <label>끝 <input className="input" type="date" value={pEnd} onChange={(e) => setPEnd(e.target.value)} /></label>
          </div>
          <button type="submit" className="btn btn-primary" disabled={!pName.trim() || !pPct}>프로모션 추가</button>
        </form>
        {promos.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 10 }}>프로모션이 없어요.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: '10px 0 0', display: 'grid', gap: 6, fontSize: 13 }}>
            {promos.map((p) => (
              <li key={p.id} className="info-box" style={{ display: 'grid', gap: 4 }}>
                <strong>{p.name} · {p.discount_pct}%</strong>
                <span style={{ color: 'var(--muted)' }}>
                  {prodName(p.product_id)} · {tierNameOf(p.tier_id)}
                  {p.starts_at || p.ends_at ? ` · ${fmtDate(p.starts_at) || '시작 없음'} ~ ${fmtDate(p.ends_at) || '끝 없음'}` : ''}
                </span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" className="btn btn-ghost" onClick={() => togglePromo(p)}>{p.active ? '끄기' : '켜기'}</button>
                  <button type="button" className="btn btn-ghost" onClick={() => removePromo(p.id)}>삭제</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
