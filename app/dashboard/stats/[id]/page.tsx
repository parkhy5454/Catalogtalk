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
  src: string | null
}

type Visit = {
  key: string
  first: string
  last: string
  maxPage: number
  dwell: number
  ua: string | null
  src: string | null
}

const REFRESH_MS = 30_000

// Labels for the ?src= tags the share sheet adds (see folders page and viewer).
const SOURCE_LABEL: Record<string, string> = {
  kakao: '카카오톡',
  sms: '문자',
  mail: '이메일',
  link: '복사한 링크',
  native: '공유하기',
}

function sourceLabel(src: string | null): string {
  if (!src) return '직접 열람·기타'
  return SOURCE_LABEL[src] ?? '기타 링크'
}

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
        src: r.src,
      })
      return
    }
    if (r.viewed_at < cur.first) cur.first = r.viewed_at
    if (r.viewed_at > cur.last) cur.last = r.viewed_at
    cur.maxPage = Math.max(cur.maxPage, page)
    cur.dwell += r.dwell_ms ?? 0
    cur.ua = cur.ua ?? r.user_agent
    cur.src = cur.src ?? r.src
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
  const [leadOn, setLeadOn] = useState(false)
  const [leadCount, setLeadCount] = useState(0)
  const [leadBusy, setLeadBusy] = useState(false)
  const [quoteOn, setQuoteOn] = useState(false)
  const [quoteCount, setQuoteCount] = useState(0)

  const load = useCallback(async () => {
    const [book, views, leads, quotes] = await Promise.all([
      supabase.from('flipbooks').select('title, page_count, views, lead_form, quote_form').eq('id', id).maybeSingle(),
      supabase
        .from('flipbook_views')
        .select('id, session_id, page_no, dwell_ms, viewed_at, user_agent, src')
        .eq('flipbook_id', id)
        .order('viewed_at', { ascending: false })
        .limit(5000),
      supabase
        .from('flipbook_leads')
        .select('id', { count: 'exact', head: true })
        .eq('flipbook_id', id),
      supabase
        .from('quote_requests')
        .select('id', { count: 'exact', head: true })
        .eq('flipbook_id', id),
    ])
    setLoading(false)
    if (!book.data) {
      setNotFound(true)
      return
    }
    setTitle(book.data.title)
    setPageCount(book.data.page_count ?? 0)
    setTotalViews(book.data.views ?? 0)
    setLeadOn(book.data.lead_form === true)
    setLeadCount(leads.count ?? 0)
    setQuoteOn(book.data.quote_form === true)
    setQuoteCount(quotes.count ?? 0)
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

  // ── 고급 열람 분석 ──────────────────────────────────────────────
  // Visits by traffic source (largest first).
  const sourceRows = useMemo(() => {
    const counts = new Map<string, number>()
    visits.forEach((v) => {
      const k = sourceLabel(v.src)
      counts.set(k, (counts.get(k) ?? 0) + 1)
    })
    return Array.from(counts, ([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count)
  }, [visits])

  // Pages that hold attention: total time spent on each page, top 5.
  const topPages = useMemo(() => {
    const total: Record<number, number> = {}
    rows.forEach((r) => {
      if (!r.page_no) return
      total[r.page_no] = (total[r.page_no] ?? 0) + (r.dwell_ms ?? 0)
    })
    return Object.entries(total)
      .map(([n, ms]) => ({ n: Number(n), ms }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 5)
  }, [rows])

  // The page where the most visits stopped reading (not counting the last page).
  const dropPage = useMemo(() => {
    let best: { n: number; lost: number } | null = null
    for (let i = 0; i < pageRows.length - 1; i++) {
      const lost = pageRows[i].reach - pageRows[i + 1].reach
      if (lost > 0 && (!best || lost > best.lost)) best = { n: pageRows[i].n, lost }
    }
    return best
  }, [pageRows])

  const deviceRows = useMemo(() => {
    const counts = new Map<string, number>()
    visits.forEach((v) => {
      const k = deviceLabel(v.ua)
      counts.set(k, (counts.get(k) ?? 0) + 1)
    })
    return Array.from(counts, ([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count)
  }, [visits])

  const toggleLead = async () => {
    if (leadBusy) return
    const next = !leadOn
    setLeadBusy(true)
    const { error } = await supabase.from('flipbooks').update({ lead_form: next }).eq('id', id)
    setLeadBusy(false)
    if (!error) setLeadOn(next)
  }

  const toggleQuote = async () => {
    if (leadBusy) return
    const next = !quoteOn
    setLeadBusy(true)
    const { error } = await supabase.from('flipbooks').update({ quote_form: next }).eq('id', id)
    setLeadBusy(false)
    if (!error) setQuoteOn(next)
  }

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
  const sourceBase = sourceRows.reduce((s, r) => s + r.count, 0) || 1

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

      <section className="panel" style={{ marginTop: 16 }} aria-labelledby="lead-title">
        <h2 className="panel-title" id="lead-title" style={{ fontSize: 16 }}>리드 수집</h2>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6 }}>
          켜면 열람 중 이름과 연락처를 받아요. 동의한 사람만 남고, 1년이 지나면 자동 삭제돼요.
        </p>
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" className={leadOn ? 'btn btn-primary' : 'btn btn-ghost'} onClick={toggleLead} disabled={leadBusy}>
            {leadOn ? '수집 켜짐 · 끄기' : '수집 꺼짐 · 켜기'}
          </button>
          <Link href={`/dashboard/leads/${id}`} className="btn btn-ghost">
            받은 리드 {leadCount.toLocaleString()}명 보기
          </Link>
        </div>
      </section>

      <section className="panel" style={{ marginTop: 16 }} aria-labelledby="notify-card-title">
        <h2 className="panel-title" id="notify-card-title" style={{ fontSize: 16 }}>알림 보내기</h2>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6 }}>
          리드 중 소식 수신에 동의한 분께 새 자료 소식을 이메일로 보내요.
        </p>
        <div style={{ marginTop: 10 }}>
          <Link href={`/dashboard/notify/${id}`} className="btn btn-ghost">알림 보내기</Link>
        </div>
      </section>

      <section className="panel" style={{ marginTop: 16 }} aria-labelledby="trans-card-title">
        <h2 className="panel-title" id="trans-card-title" style={{ fontSize: 16 }}>다국어 번역</h2>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6 }}>
          영어, 중국어, 일본어, 베트남어 번역본을 만들어 방문자에게 보여줄 수 있어요. AI 번역이라 확인이 필요해요.
        </p>
        <div style={{ marginTop: 10 }}>
          <Link href={`/dashboard/translate/${id}`} className="btn btn-ghost">번역 관리</Link>
        </div>
      </section>

      <section className="panel" style={{ marginTop: 16 }} aria-labelledby="quote-card-title">
        <h2 className="panel-title" id="quote-card-title" style={{ fontSize: 16 }}>견적 요청</h2>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6 }}>
          켜면 열람 중 상품과 수량을 적어 견적을 요청할 수 있어요. 요청은 1년 뒤 자동 삭제돼요.
        </p>
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" className={quoteOn ? 'btn btn-primary' : 'btn btn-ghost'} onClick={toggleQuote} disabled={leadBusy}>
            {quoteOn ? '요청 받기 켜짐 · 끄기' : '요청 받기 꺼짐 · 켜기'}
          </button>
          <Link href={`/dashboard/quotes/${id}`} className="btn btn-ghost">
            받은 요청 {quoteCount.toLocaleString()}건 보기
          </Link>
        </div>
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

          <section className="panel" style={{ marginTop: 16 }} aria-labelledby="adv-title">
            <h2 className="panel-title" id="adv-title" style={{ fontSize: 16 }}>고급 열람 분석</h2>

            <h3 style={{ fontSize: 14, marginTop: 14 }}>유입 경로</h3>
            <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
              {sourceRows.map((s) => {
                const pct = Math.round((s.count / sourceBase) * 100)
                return (
                  <div key={s.label} style={{ display: 'grid', gridTemplateColumns: '112px 1fr 64px', gap: 8, alignItems: 'center', fontSize: 13 }}>
                    <span className="truncate">{s.label}</span>
                    <div className="progress" aria-hidden="true">
                      <span style={{ width: `${pct}%` }} />
                    </div>
                    <span style={{ textAlign: 'right', color: 'var(--muted)' }}>{s.count}회 · {pct}%</span>
                  </div>
                )
              })}
            </div>

            <h3 style={{ fontSize: 14, marginTop: 18 }}>오래 머문 쪽 TOP 5</h3>
            {topPages.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6 }}>아직 체류 기록이 없어요.</p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', display: 'grid', gap: 6, fontSize: 13 }}>
                {topPages.map((p) => (
                  <li key={p.n} style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>{p.n}쪽</span>
                    <span style={{ color: 'var(--muted)' }}>합계 {fmtDuration(p.ms)}</span>
                  </li>
                ))}
              </ul>
            )}

            <h3 style={{ fontSize: 14, marginTop: 18 }}>가장 많이 멈춘 쪽</h3>
            <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6 }}>
              {dropPage
                ? `${dropPage.n}쪽에서 ${dropPage.lost}명이 더 넘기지 않았어요. 이 쪽 내용을 점검해 보세요.`
                : '뚜렷하게 많이 멈춘 쪽이 없어요.'}
            </p>

            <h3 style={{ fontSize: 14, marginTop: 18 }}>기기</h3>
            <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6, fontSize: 13 }}>
              {deviceRows.map((d) => (
                <span key={d.label} className="info-box" style={{ padding: '6px 10px' }}>
                  {d.label} {Math.round((d.count / visitBase) * 100)}%
                </span>
              ))}
            </div>
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
                    {sourceLabel(v.src)} · {v.maxPage}쪽까지 · 체류 {fmtDuration(v.dwell)}
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
