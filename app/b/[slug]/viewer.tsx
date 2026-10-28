'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { FlipbookPublic, PageImage } from '@/lib/flipbook/types'

const MIN_ZOOM = 1
const MAX_ZOOM = 4
const DOUBLE_TAP_ZOOM = 2.5
const SWIPE_MIN_PX = 50
const TAP_SLOP_PX = 10
const DOUBLE_TAP_MS = 300

type Props = { flipbook: FlipbookPublic; pages: PageImage[] }
type Dir = 'next' | 'prev' | null
type Pt = { x: number; y: number }

function useIsWide() {
  // Mobile-first: start as phone layout, switch to two-page spreads at >= 768px.
  const [wide, setWide] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const sync = () => setWide(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
  return wide
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export default function Viewer({ flipbook, pages }: Props) {
  const wide = useIsWide()
  const [pageIdx, setPageIdx] = useState(0)          // 0-based page currently shown
  const [views, setViews] = useState(flipbook.views || 0)
  const [zoom, setZoom] = useState(MIN_ZOOM)
  const [pan, setPan] = useState<Pt>({ x: 0, y: 0 })
  const [dragX, setDragX] = useState(0)
  const [flip, setFlip] = useState<{ key: number; dir: Dir }>({ key: 0, dir: null })

  const stageRef = useRef<HTMLDivElement>(null)
  const pointers = useRef(new Map<number, Pt>())
  const gesture = useRef({
    startPt: { x: 0, y: 0 } as Pt,
    startPan: { x: 0, y: 0 } as Pt,
    startZoom: MIN_ZOOM,
    startDist: 0,
    pinched: false,
    moved: false,
    startedAt: 0,
  })
  const lastTap = useRef<{ t: number; p: Pt } | null>(null)
  const counted = useRef(false)
  const track = useRef({ page: 0, since: 0 })

  const total = pages.length

  // Spreads: phone = one page per screen; tablet/desktop = [1], [2,3], [4,5] ...
  const spreads = useMemo(() => {
    if (!wide) return pages.map((_, i) => [i])
    const out: number[][] = []
    if (pages.length === 0) return out
    out.push([0])
    for (let i = 1; i < pages.length; i += 2) {
      out.push(i + 1 < pages.length ? [i, i + 1] : [i])
    }
    return out
  }, [pages, wide])

  const spreadIdx = useMemo(() => {
    if (!wide) return pageIdx
    if (pageIdx === 0) return 0
    return Math.floor((pageIdx + 1) / 2)
  }, [pageIdx, wide])

  const currentSpread = spreads[spreadIdx] ?? []
  const canPrev = spreadIdx > 0
  const canNext = spreadIdx < spreads.length - 1

  const goToSpread = useCallback(
    (nextSpread: number) => {
      if (nextSpread < 0 || nextSpread >= spreads.length) return
      const firstPage = spreads[nextSpread][0]
      setFlip((f) => ({ key: f.key + 1, dir: nextSpread > spreadIdx ? 'next' : 'prev' }))
      setPageIdx(firstPage)
      setZoom(MIN_ZOOM)
      setPan({ x: 0, y: 0 })
    },
    [spreads, spreadIdx]
  )

  const next = useCallback(() => goToSpread(spreadIdx + 1), [goToSpread, spreadIdx])
  const prev = useCallback(() => goToSpread(spreadIdx - 1), [goToSpread, spreadIdx])

  // Keyboard arrows (desktop / tablet with keyboard).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') next()
      if (e.key === 'ArrowLeft') prev()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [next, prev])

  // Count one view per page load. Ref guard protects against double effects in dev.
  useEffect(() => {
    if (counted.current) return
    counted.current = true
    const supabase = createClient()
    supabase.rpc('increment_view', { fb_id: flipbook.id }).then(() => {})
    setViews((v) => v + 1)
  }, [flipbook.id])

  // Page-level analytics: each page change logs the dwell time of the page just left.
  const logView = useCallback(
    (pageNo: number, dwellMs: number) => {
      if (!flipbook.id) return
      createClient()
        .from('flipbook_views')
        .insert({
          flipbook_id: flipbook.id,
          page_no: pageNo,
          dwell_ms: Math.max(0, Math.min(dwellMs, 3_600_000)),
          user_agent: navigator.userAgent.slice(0, 255),
        })
        .then(() => {})
    },
    [flipbook.id]
  )

  useEffect(() => {
    const now = Date.now()
    const prev = track.current
    if (prev.since) logView(prev.page + 1, now - prev.since)
    track.current = { page: pageIdx, since: now }
  }, [pageIdx, logView])

  // Flush the last page's dwell time when the viewer is hidden or closed.
  useEffect(() => {
    const flush = () => {
      const now = Date.now()
      const cur = track.current
      if (cur.since) logView(cur.page + 1, now - cur.since)
      track.current = { page: cur.page, since: now }
    }
    const onVis = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('pagehide', flush)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('pagehide', flush)
    }
  }, [logView])

  // Preload neighbouring images so swipes feel instant on mobile networks.
  useEffect(() => {
    const neighbours = [spreads[spreadIdx + 1], spreads[spreadIdx - 1]].filter(Boolean) as number[][]
    neighbours.flat().forEach((i) => {
      const src = pages[i]?.image_url
      if (src) {
        const img = new Image()
        img.decoding = 'async'
        img.src = src
      }
    })
  }, [spreads, spreadIdx, pages])

  // ---------- Gestures: swipe, pinch-zoom, pan, double-tap ----------
  const clampPan = (p: Pt, z: number): Pt => {
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect) return p
    const maxX = ((z - 1) * rect.width) / 2
    const maxY = ((z - 1) * rect.height) / 2
    return { x: clamp(p.x, -maxX, maxX), y: clamp(p.y, -maxY, maxY) }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    stageRef.current?.setPointerCapture?.(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const g = gesture.current
    if (pointers.current.size === 1) {
      g.startPt = { x: e.clientX, y: e.clientY }
      g.startPan = pan
      g.startZoom = zoom
      g.pinched = false
      g.moved = false
      g.startedAt = Date.now()
    } else if (pointers.current.size === 2) {
      const [a, b] = Array.from(pointers.current.values())
      g.startDist = dist(a, b)
      g.startZoom = zoom
      g.pinched = true
      setDragX(0)
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const g = gesture.current

    if (pointers.current.size >= 2) {
      const [a, b] = Array.from(pointers.current.values())
      const nz = clamp((g.startZoom * dist(a, b)) / (g.startDist || 1), MIN_ZOOM, MAX_ZOOM)
      setZoom(nz)
      setPan((p) => clampPan(p, nz))
      return
    }

    const dx = e.clientX - g.startPt.x
    const dy = e.clientY - g.startPt.y
    if (Math.hypot(dx, dy) > TAP_SLOP_PX) g.moved = true

    if (zoom > 1) {
      // Zoomed in: one finger pans the page.
      setPan(clampPan({ x: g.startPan.x + dx, y: g.startPan.y + dy }, zoom))
    } else if (Math.abs(dx) > Math.abs(dy)) {
      // Phone swipe preview: the page follows the finger.
      setDragX(dx)
    }
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.delete(e.pointerId)
    const g = gesture.current
    if (pointers.current.size > 0) return // still one finger down after a pinch

    if (g.pinched) {
      // Snap back to 100% if the pinch ended close to the original size.
      if (zoom < 1.05) {
        setZoom(MIN_ZOOM)
        setPan({ x: 0, y: 0 })
      }
      g.pinched = false
      return
    }

    const dx = e.clientX - g.startPt.x
    const dy = e.clientY - g.startPt.y
    setDragX(0)

    if (zoom <= 1 && Math.abs(dx) > SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy) * 1.2) {
      if (dx < 0) next()
      else prev()
      return
    }

    // Tap: double-tap toggles zoom.
    if (!g.moved && Date.now() - g.startedAt < 300) {
      const now = Date.now()
      const last = lastTap.current
      if (last && now - last.t < DOUBLE_TAP_MS && dist(last.p, { x: e.clientX, y: e.clientY }) < 30) {
        lastTap.current = null
        if (zoom > 1) {
          setZoom(MIN_ZOOM)
          setPan({ x: 0, y: 0 })
        } else {
          setZoom(DOUBLE_TAP_ZOOM)
          setPan({ x: 0, y: 0 })
        }
      } else {
        lastTap.current = { t: now, p: { x: e.clientX, y: e.clientY } }
      }
    }
  }

  const flipClass = flip.dir === 'next' ? 'flip-next' : flip.dir === 'prev' ? 'flip-prev' : ''
  const pageLabel = currentSpread.length > 1
    ? `${currentSpread[0] + 1}–${currentSpread[1] + 1}`
    : `${(currentSpread[0] ?? 0) + 1}`

  const hasPages = total > 0

  return (
    <div className="viewer">
      <header className="viewer-top">
        <div style={{ minWidth: 0 }}>
          <div className="viewer-title truncate" title={flipbook.title}>{flipbook.title}</div>
          <div className="viewer-meta">조회 {views.toLocaleString()}회</div>
        </div>
        {flipbook.pdf_url && (
          <a className="btn btn-dark" href={flipbook.pdf_url} target="_blank" rel="noopener" style={{ minHeight: 48, padding: '0 14px', fontSize: 14 }}>
            PDF
          </a>
        )}
      </header>

      {hasPages ? (
        <>
          <div
            ref={stageRef}
            className="stage"
            role="region"
            aria-label={`${flipbook.title} 페이지 보기. 좌우로 밀어서 넘기고, 두 손가락으로 확대할 수 있어요.`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <div
              key={flip.key}
              className={`spread${currentSpread.length > 1 ? ' is-two' : ''} ${flipClass}`}
              style={{
                transform: `translate3d(${pan.x + dragX}px, ${pan.y}px, 0) scale(${zoom})`,
                transition: dragX === 0 && zoom === MIN_ZOOM ? 'transform 0.25s ease' : 'none',
              }}
            >
              {currentSpread.map((i) => (
                <img
                  key={pages[i].page_no}
                  className="page-img"
                  src={pages[i].image_url}
                  alt={`${pages[i].page_no}페이지`}
                  loading="eager"
                  decoding="async"
                  draggable={false}
                />
              ))}
            </div>
          </div>

          {wide && (
            <nav className="thumbs" aria-label="페이지 목록">
              {pages.map((p, i) => (
                <button
                  key={p.page_no}
                  type="button"
                  className={`thumb${currentSpread.includes(i) ? ' is-current' : ''}`}
                  onClick={() => goToSpread(spreads.findIndex((s) => s.includes(i)))}
                  aria-label={`${p.page_no}페이지로 이동`}
                  aria-current={currentSpread.includes(i) ? 'page' : undefined}
                >
                  <img src={p.image_url} alt="" loading="lazy" decoding="async" />
                </button>
              ))}
            </nav>
          )}

          <div className="viewer-controls">
            <button type="button" className="nav-btn" onClick={prev} disabled={!canPrev} aria-label="이전 페이지">
              ‹
            </button>
            <div className="page-count" aria-live="polite">
              {pageLabel} / {total}쪽
              {!wide && <span className="zoom-hint">두 손가락으로 확대 · 두 번 탭</span>}
            </div>
            <button type="button" className="nav-btn" onClick={next} disabled={!canNext} aria-label="다음 페이지">
              ›
            </button>
          </div>
        </>
      ) : (
        <div className="viewer-empty" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
          <div>이 카탈로그는 모바일 뷰어 이미지가 아직 없어요.</div>
          {flipbook.pdf_url && (
            <a className="btn btn-kakao" href={flipbook.pdf_url} target="_blank" rel="noopener">PDF 열기</a>
          )}
        </div>
      )}
    </div>
  )
}
