'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

type ViewRow = {
  id: string
  session_id: string | null
  page_no: number | null
  dwell_ms: number | null
  viewed_at: string
  user_agent: string | null
}

type Visit = {
  key: string
  first: string
  last: string
  maxPage: number
  dwell: number
  ua: string | null
}

const REFRESH_MS = 30_000

function deviceLabel(ua: string | null): string {
  if (!ua) return '알 수 없음'
  if (/iPhone|iPad/.test(ua)) return 'iPhone'
  if (/Android/.test(ua)) return 'Android'
  if (/Windows/.test(ua)) return 'Windows'
  if (/Macintosh/.test(ua)) return 'Mac'
  return '기타'
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}초`
  return `${Math.floor(s / 60)}분 ${s % 60}초`
}

// Groups page rows into visits. Rows without a session id each count as their own visit.
function buildVisits(rows: ViewRow[]): Visit[] {
  const map = new Map<string, Visit>()
  rows.forEach((r, i) => {
    const key = r.session_id ?? `row:${i}`
    const page = r.page_no ?? 0
    const cur = map.get(key)
    if (!cur) {
      map.set(key, {
        key,
        first: r.viewed_at,
        last: r.viewed_at,
        maxPage: page,
        dwell: r.dwell_ms ?? 0,
        ua: r.user_agent,
      })
      return
    }
    if (r.viewed_at < cur.first) cur.first = r.viewed_at
    if (r.viewed_at > cur.last) cur.last = r.viewed_at
    cur.maxPage = Math.max(cur.maxPage, page)
    cur.dwell += r.dwell_ms ?? 0
    cur.ua = cur.ua ?? r.user_agent
  })
  return Array.from(map.values()).sort((a, b) => (a.last < b.last ? 1 : -1))
}

export default function FlipbookStatsPage() {
  const { id } = useParams<{ id: string }>()
  const supabase = createClient()
  const [title, setTitle] = useState('')
  const [pageCount, setPageCount] = useState(0)
  const [totalViews, setTotalViews] = useState(0)
  const [rows, setRows] = useState<ViewRow[]>([])
  const [notFound, setNotFound] = useState(false)
  const [loading, setLoading] = useState(true)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)

  const load = useCallback(async () => {
    const [book, views] = await Promise.all([
      supabase.from('flipbooks').select('title, page_count, views').eq('id', id).maybeSingle(),
      supabase
        .from('flipbook_views')
        .select('id, session_id, page_no, dwell_ms, viewed_at, user_agent')
        .eq('flipbook_id', id)
        .order('viewed_at', { ascending: false })
        .limit(5000),
    ])
    setLoading(false)
    if (!book.data) {
      setNotFound(true)
      return
    }
    setTitle(book.data.title)
    setPageCount(book.data.page_count ?? 0)
    setTotalViews(book.data.views ?? 0)
    setRows((views.data as ViewRow[]) ?? [])
    setUpdatedAt(new Date())
  }, [id])

  useEffect(() => {
    load()
    const timer = window.setInterval(load, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [load])

  const visits = useMemo(() => buildVisits(rows), [rows])

  const summary = useMemo(() => {
    const todayKey = new Date().toDateString()
    const today = visits.filter((v) => new Date(v.last).toDateString() === todayKey).length
    const totalDwell = visits.reduce((s, v) => s + v.dwell, 0)
    const avgDwell = visits.length ? totalDwell / visits.length : 0
    const finished = visits.filter((v) => pageCount > 0 && v.maxPage >= pageCount).length
    return { today, avgDwell, finished }
  }, [visits, pageCount])

  // Reach: how many visits got at least to page n (by the last page logged for that visit).
  const maxSeen = visits.reduce((m, v) => Math.max(m, v.maxPage), 0)
  const lastPage = Math.min(Math.max(pageCount, maxSeen), 200)
  const pageRows = useMemo(() => {
    const dwellSum: Record<number, number> = {}
    const dwellCount: Record<number, number> = {}
    rows.forEach((r) => {
      if (!r.page_no) return
      dwellSum[r.page_no] = (dwellSum[r.page_no] ?? 0) + (r.dwell_ms ?? 0)
      dwellCount[r.page_no] = (dwellCount[r.page_no] ?? 0) + 1
    })
    return Array.from({ length: lastPage }, (_, i) => {
      const n = i + 1
      const reach = visits.filter((v) => v.maxPage >= n).length
      const avg = dwellCount[n] ? dwellSum[n] / dwellCount[n] : 0
      return { n, reach, avg }
    })
  }, [rows, visits, lastPage])

  if (loading) {
    return (
      <main className="container section">
        <div className="skeleton" style={{ height: 220 }} aria-hidden="true" />
      </main>
    )
  }

  if (notFound) {
    return (
      <main className="container section">
        <div className="notice notice-error">플립북을 찾을 수 없어요.</div>
        <Link href="/dashboard/folders" className="btn btn-ghost btn-block" style={{ marginTop: 16 }}>
          My Book으로 돌아가기
        </Link>
      </main>
    )
  }

  const visitBase = visits.length || 1

  return (
    <main className="container section">
      <Link href="/dashboard/folders" className="btn btn-ghost" style={{ marginBottom: 12 }}>
        ← My Book
      </Link>

      <section className="panel">
        <div className="panel-head">
          <h1 className="panel-title" style={{ wordBreak: 'keep-all' }}>{title} 통계</h1>
          <button type="button" className="btn btn-ghost" onClick={load}>새로고침</button>
        </div>
        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
          {updatedAt ? `${updatedAt.toLocaleTimeString('ko-KR')} 기준 · 30초마다 자동 갱신` : ''}
        </p>

        <div className="stats" style={{ marginTop: 16 }}>
          <div className="stat">
            <div className="stat-label">방문</div>
            <div className="stat-value">{visits.length.toLocaleString()}회</div>
          </div>
          <div className="stat">
            <div className="stat-label">오늘 방문</div>
            <div className="stat-value">{summary.today.toLocaleString()}회</div>
          </div>
          <div className="stat">
            <div className="stat-label">평균 체류</div>
            <div className="stat-value">{fmtDuration(summary.avgDwell)}</div>
          </div>
        </div>
        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
          총 조회수 {totalViews.toLocaleString()}회 · 끝까지 본 방문 {summary.finished}회
        </p>
      </section>

      {visits.length === 0 ? (
        <div className="notice notice-info" style={{ marginTop: 16 }}>
          아직 방문 기록이 없어요. 링크를 보내면 여기에 쌓여요.
        </div>
      ) : (
        <>
          <section className="panel" style={{ marginTop: 16 }}>
            <h2 className="panel-title" style={{ fontSize: 16 }}>페이지별 도달률</h2>
            <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              해당 페이지까지 넘긴 방문 비율입니다.
            </p>
            <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
              {pageRows.map((p) => {
                const pct = Math.round((p.reach / visitBase) * 100)
                return (
                  <div key={p.n} style={{ display: 'grid', gridTemplateColumns: '48px 1fr 96px', gap: 8, alignItems: 'center', fontSize: 13 }}>
                    <span>{p.n}쪽</span>
                    <div className="progress" aria-hidden="true">
                      <span style={{ width: `${pct}%` }} />
                    </div>
                    <span style={{ textAlign: 'right', color: 'var(--muted)' }}>
                      {p.reach}명 · {pct}%{p.avg ? ` · ${(p.avg / 1000).toFixed(1)}초` : ''}
                    </span>
                  </div>
                )
              })}
            </div>
            <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10 }}>
              오른쪽 숫자의 초는 그 페이지에 머문 평균 시간입니다.
            </p>
          </section>

          <section className="panel" style={{ marginTop: 16 }}>
            <h2 className="panel-title" style={{ fontSize: 16 }}>최근 방문</h2>
            <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0', display: 'grid', gap: 8 }}>
              {visits.slice(0, 30).map((v) => (
                <li key={v.key} className="info-box" style={{ fontSize: 13 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <strong>{fmtTime(v.last)}</strong>
                    <span style={{ color: 'var(--muted)' }}>{deviceLabel(v.ua)}</span>
                  </div>
                  <div style={{ color: 'var(--muted)', marginTop: 4 }}>
                    {v.maxPage}쪽까지 · 체류 {fmtDuration(v.dwell)}
                    {pageCount > 0 && v.maxPage >= pageCount ? ' · 끝까지 봄' : ''}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </main>
  )
}
