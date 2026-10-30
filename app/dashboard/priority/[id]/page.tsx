'use client'
// Sales priority: the leads of one catalog, ranked by how engaged their visit was.
// Scores come from get_lead_priorities (v37): time, pages, finishing, and a quote request in the same visit.
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

type Row = {
  lead_id: string
  name: string
  contact: string
  marketing_consent: boolean
  lead_created_at: string
  max_page: number
  page_count: number
  dwell_ms: number
  finished: boolean
  quote_requested: boolean
  score: number
}

function tier(score: number): { label: string; color: string } {
  if (score >= 40) return { label: '높음', color: '#c0392b' }
  if (score >= 15) return { label: '보통', color: '#b9770e' }
  return { label: '낮음', color: 'var(--muted)' }
}

function reasons(r: Row): string[] {
  const out: string[] = []
  if (r.quote_requested) out.push('견적 요청함')
  if (r.finished) out.push('끝까지 봄')
  if (r.max_page > 0) out.push(`${r.max_page}쪽까지`)
  const minutes = Math.round(r.dwell_ms / 60000)
  if (r.dwell_ms > 0) out.push(minutes >= 1 ? `체류 ${minutes}분` : '체류 1분 미만')
  if (out.length === 0) out.push('열람 기록 없음')
  return out
}

export default function PriorityPage() {
  const { id } = useParams<{ id: string }>()
  const supabase = createClient()
  const [title, setTitle] = useState('')
  const [notFound, setNotFound] = useState(false)
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [book, res] = await Promise.all([
      supabase.from('flipbooks').select('title').eq('id', id).maybeSingle(),
      supabase.rpc('get_lead_priorities', { p_flipbook: id }),
    ])
    if (!book.data) return setNotFound(true)
    setTitle(book.data.title)
    if (res.error) return setError('목록을 불러오지 못했어요')
    setRows((res.data as Row[]) ?? [])
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  if (notFound) {
    return (
      <main className="container section">
        <div className="notice notice-error">자료를 찾을 수 없어요.</div>
        <Link href="/dashboard/folders" className="btn btn-ghost btn-block" style={{ marginTop: 16 }}>My Book으로 돌아가기</Link>
      </main>
    )
  }

  const high = rows?.filter((r) => r.score >= 40).length ?? 0
  const asked = rows?.filter((r) => r.quote_requested).length ?? 0

  return (
    <main className="container section">
      <Link href={`/dashboard/stats/${id}`} className="btn btn-ghost" style={{ marginBottom: 12 }}>← 통계</Link>
      <Link href={`/dashboard/sales/${id}`} className="btn btn-ghost" style={{ marginBottom: 12, marginLeft: 6 }}>AI 영업 분석</Link>

      <section className="panel">
        <div className="panel-head">
          <h1 className="panel-title" style={{ wordBreak: 'keep-all' }}>{title} 영업 우선순위</h1>
        </div>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
          연락처를 남긴 분이 같은 방문에서 얼마나 깊이 봤는지로 순서를 정했어요. 점수는 체류 시간(최대 20), 본 쪽 수(최대 10), 끝까지 봤는지(30), 같은 방문에서 견적을 요청했는지(40)를 더해 계산해요.
        </p>

        {rows && rows.length > 0 && (
          <div className="info-box" style={{ marginTop: 12, fontSize: 13 }}>
            <div>우선 연락할 분: 점수 높음 {high}명{asked > 0 ? ` · 견적 요청 ${asked}명` : ''}</div>
          </div>
        )}

        {error && <div className="notice notice-error" role="alert" style={{ marginTop: 12 }}>{error}</div>}

        {rows === null ? (
          <div className="skeleton" style={{ height: 120, marginTop: 12 }} aria-hidden="true" />
        ) : rows.length === 0 ? (
          <div className="notice notice-info" style={{ marginTop: 12 }}>아직 연락처를 남긴 분이 없어요. 리드 수집을 켜면 여기에서 순위를 볼 수 있어요.</div>
        ) : (
          <ol style={{ listStyle: 'none', padding: 0, margin: '12px 0 0', display: 'grid', gap: 8 }}>
            {rows.map((r, i) => {
              const t = tier(r.score)
              return (
                <li key={r.lead_id} className="info-box" style={{ display: 'grid', gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                    <strong className="truncate">{i + 1}. {r.name}</strong>
                    <span style={{ fontSize: 12, color: t.color, whiteSpace: 'nowrap' }}>{t.label} · {r.score}점</span>
                  </div>
                  <span className="truncate" style={{ fontSize: 13 }}>{r.contact}</span>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>{reasons(r).join(' · ')}</span>
                </li>
              )
            })}
          </ol>
        )}
        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12 }}>
          열람 기록은 발행자가 받은 연락처와 같은 방문으로만 이어져요. 점수로 연락 순서를 정하는 데만 쓰세요.
        </p>
      </section>
    </main>
  )
}
