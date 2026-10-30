'use client'
// Public buyer directory: catalogs the publishers chose to list. Buyers can search, open a catalog,
// and send a quote request from the viewer when the publisher accepts quotes.
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { DIRECTORY_CATEGORIES } from '@/lib/directory'
import { SITE_NAME } from '@/lib/site'

type Item = {
  id: string
  title: string
  slug: string
  thumb_url: string | null
  summary: string | null
  category: string | null
  page_count: number
  quote_form: boolean
}

export default function DirectoryPage() {
  const supabase = createClient()
  const [category, setCategory] = useState('')
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<Item[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    const { data, error: err } = await supabase.rpc('list_directory', {
      p_category: category || null,
      p_query: query.trim() || null,
    })
    if (err) return setError('목록을 불러오지 못했어요')
    setItems((data as Item[]) ?? [])
  }, [category, query])

  useEffect(() => {
    const t = window.setTimeout(() => void load(), 200)
    return () => window.clearTimeout(t)
  }, [load])

  return (
    <main className="container section">
      <section className="panel">
        <div className="panel-head">
          <h1 className="panel-title">{SITE_NAME} 바이어 디렉터리</h1>
        </div>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
          발행자가 공개한 카탈로그예요. 자료를 보고 필요하면 견적을 요청할 수 있어요.
        </p>

        <input
          className="input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="상품명이나 설명으로 찾기"
          maxLength={50}
          style={{ marginTop: 12, width: '100%' }}
        />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
          <button type="button" className={category === '' ? 'btn btn-primary' : 'btn btn-ghost'} onClick={() => setCategory('')}>전체</button>
          {DIRECTORY_CATEGORIES.map((c) => (
            <button key={c} type="button" className={category === c ? 'btn btn-primary' : 'btn btn-ghost'} onClick={() => setCategory(c)}>{c}</button>
          ))}
        </div>

        {error && <div className="notice notice-error" role="alert" style={{ marginTop: 12 }}>{error}</div>}

        {items === null ? (
          <div className="skeleton" style={{ height: 160, marginTop: 12 }} aria-hidden="true" />
        ) : items.length === 0 ? (
          <div className="notice notice-info" style={{ marginTop: 12 }}>조건에 맞는 자료가 없어요.</div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0', display: 'grid', gap: 10 }}>
            {items.map((it) => (
              <li key={it.id}>
                <Link href={`/b/${it.slug}`} className="info-box" style={{ display: 'grid', gridTemplateColumns: '72px 1fr', gap: 12, alignItems: 'center', textDecoration: 'none', color: 'inherit' }}>
                  {it.thumb_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={it.thumb_url} alt="" style={{ width: 72, height: 96, objectFit: 'cover', borderRadius: 6 }} loading="lazy" />
                  ) : (
                    <div style={{ width: 72, height: 96, borderRadius: 6, background: '#eee' }} aria-hidden="true" />
                  )}
                  <div style={{ minWidth: 0 }}>
                    <strong className="truncate" style={{ display: 'block' }}>{it.title}</strong>
                    {it.summary && <p style={{ fontSize: 13, color: 'var(--muted)', margin: '4px 0 0' }}>{it.summary}</p>}
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {it.category ?? '기타'} · {it.page_count}쪽{it.quote_form ? ' · 견적 요청 가능' : ''}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
