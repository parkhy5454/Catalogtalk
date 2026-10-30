'use client'
// Customer pipeline: every inquiry across the owner's catalogs, grouped by stage. Move a customer with ◀ ▶.
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { STAGES, type StageKey } from '@/lib/crm'

type Card = { id: string; name: string; stage: StageKey; created_at: string; flipbooks: { title: string } | { title: string }[] | null }

const catalogTitle = (c: Card) => (Array.isArray(c.flipbooks) ? c.flipbooks[0]?.title : c.flipbooks?.title) ?? ''

export default function PipelinePage() {
  const [cards, setCards] = useState<Card[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data, error: err } = await createClient()
      .from('flipbook_leads')
      .select('id, name, stage, created_at, flipbooks(title)')
      .order('created_at', { ascending: false })
      .limit(300)
    if (err) return setError('목록을 불러오지 못했어요')
    setCards((data as unknown as Card[]) ?? [])
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const move = async (c: Card, dir: 1 | -1) => {
    const i = STAGES.findIndex((s) => s.key === c.stage)
    const next = STAGES[i + dir]
    if (!next) return
    const { error: err } = await createClient().from('flipbook_leads').update({ stage: next.key }).eq('id', c.id)
    if (err) return setError('단계를 바꾸지 못했어요')
    setCards((prev) => (prev ? prev.map((x) => (x.id === c.id ? { ...x, stage: next.key } : x)) : prev))
  }

  const total = cards?.length ?? 0
  const won = cards?.filter((c) => c.stage === 'won').length ?? 0

  return (
    <main className="container section">
      <Link href="/dashboard" className="btn btn-ghost" style={{ marginBottom: 12 }}>← 대시보드</Link>
      <h1 className="panel-title">고객 파이프라인</h1>
      <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
        전체 {total}명 · 성사 {won}명. 이름을 누르면 고객 기록이 열려요.
      </p>
      {error && <div className="notice notice-error" role="alert" style={{ marginTop: 10 }}>{error}</div>}

      {cards === null ? (
        <div className="skeleton" style={{ height: 160, marginTop: 14 }} aria-hidden="true" />
      ) : (
        <div style={{ display: 'grid', gap: 12, marginTop: 14, gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
          {STAGES.map((s) => {
            const col = cards.filter((c) => c.stage === s.key)
            return (
              <section key={s.key} className="panel" style={{ padding: 12 }}>
                <h2 style={{ fontSize: 14, margin: 0 }}>{s.label} <span style={{ color: 'var(--muted)' }}>{col.length}</span></h2>
                <ul style={{ listStyle: 'none', padding: 0, margin: '10px 0 0', display: 'grid', gap: 8 }}>
                  {col.map((c) => {
                    const i = STAGES.findIndex((x) => x.key === c.stage)
                    return (
                      <li key={c.id} className="info-box" style={{ display: 'grid', gap: 6 }}>
                        <Link href={`/dashboard/customers/${c.id}`} className="truncate" style={{ fontWeight: 600 }}>{c.name || '이름 없음'}</Link>
                        <span style={{ fontSize: 12, color: 'var(--muted)' }} className="truncate">{catalogTitle(c)}</span>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                          <button type="button" className="btn btn-ghost" onClick={() => move(c, -1)} disabled={i === 0}>◀</button>
                          <button type="button" className="btn btn-ghost" onClick={() => move(c, 1)} disabled={i === STAGES.length - 1}>▶</button>
                        </div>
                      </li>
                    )
                  })}
                  {col.length === 0 && <li style={{ fontSize: 12, color: 'var(--muted)' }}>비어 있어요</li>}
                </ul>
              </section>
            )
          })}
        </div>
      )}
    </main>
  )
}
