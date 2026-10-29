'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { playPageTurn, unlockAudio } from '@/lib/flipbook/sound'
import type { FlipbookPublic, PageImage } from '@/lib/flipbook/types'
import type { PageFlip } from 'page-flip'
import ZoomView from './zoom-view'

const SOUND_KEY = 'catalogtalk-page-sound'
const BOOK_WIDTH = 1000 // logical page width; the library scales it to the container

type Props = { flipbook: FlipbookPublic; pages: PageImage[] }

function useIsWide() {
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

function readSoundPref(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off'
  } catch {
    return true
  }
}

function saveSoundPref(on: boolean) {
  try {
    localStorage.setItem(SOUND_KEY, on ? 'on' : 'off')
  } catch {
    /* private mode: keep it in memory only */
  }
}

const isTouchUI = () => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches

export default function Viewer({ flipbook, pages }: Props) {
  const wide = useIsWide()
  const areaRef = useRef<HTMLDivElement>(null)
  const bookRef = useRef<PageFlip | null>(null)
  const slidePrevRef = useRef<(() => void) | null>(null) // phone: back = slide-in, not curl
  const skipFlipSound = useRef(false) // a slide-in already played its sound
  const soundRef = useRef(true)

  const urls = pages.map((p) => p.image_url)
  const total = urls.length

  const [ratio, setRatio] = useState<number | null>(null) // page height / width
  const [box, setBox] = useState<{ w: number; h: number } | null>(null)
  const [ready, setReady] = useState(false)
  const [pageIdx, setPageIdx] = useState(0)
  const pageIdxRef = useRef(0) // survives book re-creation (e.g. on rotation)
  const [views, setViews] = useState(flipbook.views || 0)
  const [soundOn, setSoundOn] = useState(true)
  const [zoomIdx, setZoomIdx] = useState<number | null>(null)
  const counted = useRef(false)
  const track = useRef({ page: 0, since: 0 })

  // 1. Read the page shape from the first image so the book keeps the catalog's proportions.
  useEffect(() => {
    if (!urls[0]) return
    const img = new Image()
    img.onload = () => {
      if (img.naturalWidth > 0) setRatio(img.naturalHeight / img.naturalWidth)
      else setRatio(1.414)
    }
    img.onerror = () => setRatio(1.414)
    img.src = urls[0]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flipbook.id])

  // Measure the book area so the page size always fits it (phone: one page; wide: two-page spread).
  useEffect(() => {
    const area = areaRef.current
    if (!area || ratio === null) return
    const measure = () => {
      // Side gutter mirrors the CSS breakpoints (16 / 24 / 32px).
      const gutter = window.innerWidth >= 1200 ? 32 : window.innerWidth >= 768 ? 24 : 16
      setBox({ w: area.clientWidth - gutter * 2, h: area.clientHeight - 16 })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(area)
    return () => ro.disconnect()
  }, [ratio, total])

  // Page width in CSS px, rounded so tiny resizes do not rebuild the book.
  // Always one page at a time (phones and tablets alike); the book is kept narrower than
  // two pages so page-flip never switches to a two-page spread.
  const pageW = (() => {
    if (!box || ratio === null || box.w <= 0 || box.h <= 0) return null
    const byHeight = box.h / ratio
    const w = Math.min(box.w, byHeight)
    return Math.max(120, Math.floor(w / 8) * 8)
  })()

  // 2. Build the page-turn book (curl animation, drag/swipe, corners).
  useEffect(() => {
    const area = areaRef.current
    if (!area || total === 0 || ratio === null || pageW === null) return
    let disposed = false
    let book: PageFlip | null = null

    // page-flip removes its root element on destroy(), so every book gets a fresh node.
    const host = document.createElement('div')
    host.className = 'book-host'
    // Narrow host = one-page layout. Centered horizontally inside the area.
    host.style.width = `${pageW}px`
    host.style.left = '50%'
    host.style.right = 'auto'
    host.style.transform = 'translateX(-50%)'
    // Resting view: a plain image of the current page (sharp on iOS). The 3D page-turn layers
    // below it are shown only while a page is actually turning, then this image comes back.
    const still = document.createElement('img')
    still.className = 'book-still'
    still.alt = ''
    still.draggable = false
    still.style.width = `${pageW}px`
    still.style.height = `${Math.round(pageW * ratio)}px`
    host.appendChild(still)
    const showStill = (i: number) => {
      still.src = urls[i] ?? ''
      still.style.display = 'block'
    }
    const hideStill = () => {
      still.style.display = 'none'
    }
    // Phones: going back slides the previous page in from the left (no curl, see slidePrev).
    const slideIn = document.createElement('img')
    slideIn.className = 'book-still'
    slideIn.alt = ''
    slideIn.draggable = false
    slideIn.style.width = `${pageW}px`
    slideIn.style.height = `${Math.round(pageW * ratio)}px`
    slideIn.style.zIndex = '3'
    host.appendChild(slideIn)
    area.appendChild(host)

    soundRef.current = readSoundPref()
    setSoundOn(soundRef.current)

    import('page-flip').then(({ PageFlip }) => {
      if (disposed) return
      book = new PageFlip(host, {
        width: pageW,
        height: Math.round(pageW * ratio),
        size: 'fixed',
        showCover: true, // first page is a cover shown alone, like a printed book
        usePortrait: true, // single-page layout; the host width above keeps it from spreading
        startPage: pageIdxRef.current,
        drawShadow: true,
        maxShadowOpacity: 0.5,
        flippingTime: 700,
        mobileScrollSupport: false, // touch drags turn pages instead of scrolling the page
        swipeDistance: 30,
        showPageCorners: true,
        disableFlipByClick: false,
        clickEventForward: true,
        useMouseEvents: true,
      })

      // The library enters the "flipping" state when a turn animation starts
      // (a finished drag or a button press), so the sound plays only for real turns.
      const slidePrev = () => {
        const b = book
        if (!b) return
        const cur = b.getCurrentPageIndex()
        if (cur <= 0 || slideIn.getAnimations().length > 0) return
        const prev = cur - 1
        slideIn.src = urls[prev] ?? ''
        slideIn.style.display = 'block'
        hideStill()
        if (soundRef.current) playPageTurn()
        // The previous page opens out from the left (spine) edge, like a page folding back.
        slideIn.style.transformOrigin = 'left center'
        const anim = slideIn.animate(
          [
            { transform: 'translate(-50%, -50%) perspective(1400px) rotateY(-80deg)', opacity: 0.4 },
            { transform: 'translate(-50%, -50%) perspective(1400px) rotateY(0deg)', opacity: 1 },
          ],
          { duration: 480, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' }
        )
        anim.onfinish = () => {
          if (disposed) return
          // Jump the book to the page now shown, without a second curl or sound.
          skipFlipSound.current = true
          b.turnToPage(prev)
          skipFlipSound.current = false
          slideIn.style.display = 'none'
          pageIdxRef.current = prev
          setPageIdx(prev)
          showStill(prev)
        }
      }
      slidePrevRef.current = slidePrev

      book.on('changeState', (e) => {
        if (e.data === 'flipping' && soundRef.current && !skipFlipSound.current) playPageTurn()
        // Back to rest: show the crisp still of the current page; while dragging/turning, hide it.
        if (e.data === 'read') showStill(book?.getCurrentPageIndex() ?? 0)
        else hideStill()
      })
      book.on('flip', (e) => {
        const i = Number(e.data)
        pageIdxRef.current = i
        setPageIdx(i)
      })
      book.on('init', () => {
        if (disposed) return
        setReady(true)
        showStill(book?.getCurrentPageIndex() ?? pageIdxRef.current)
      })
      book.loadFromImages(urls)
      bookRef.current = book
    })

    return () => {
      disposed = true
      book?.destroy()
      host.remove()
      bookRef.current = null
      setReady(false)
    }
    // urls is derived from pages (stable for a given flipbook)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratio, total, flipbook.id, pageW])

  // 3. Count one view per page load (ref guard protects against dev double effects).
  useEffect(() => {
    if (counted.current) return
    counted.current = true
    createClient().rpc('increment_view', { fb_id: flipbook.id }).then(() => undefined)
    setViews((v) => v + 1)
  }, [flipbook.id])

  // 4. Page analytics: each page change logs the time spent on the page just left.
  const logView = useCallback(
    (pageNo: number, dwellMs: number) => {
      createClient()
        .from('flipbook_views')
        .insert({
          flipbook_id: flipbook.id,
          page_no: pageNo,
          dwell_ms: Math.max(0, Math.min(dwellMs, 3_600_000)),
          user_agent: navigator.userAgent.slice(0, 255),
        })
        .then(() => undefined)
    },
    [flipbook.id]
  )

  useEffect(() => {
    const now = Date.now()
    const prev = track.current
    if (prev.since) logView(prev.page + 1, now - prev.since)
    track.current = { page: pageIdx, since: now }
  }, [pageIdx, logView])

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

  // 5. Keyboard arrows (desktop / tablet with keyboard).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') bookRef.current?.flipNext()
      if (e.key === 'ArrowLeft') bookRef.current?.flipPrev()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Forward swipe on phones: page-flip treats most single-page touches as "back" in portrait
  // mode, so a leftward swipe is detected here and turns the page forward when the library did not.
  const swipeStart = useRef<{ x: number; y: number; idx: number } | null>(null)
  const onAreaDown = (e: React.PointerEvent<HTMLDivElement>) => {
    unlockAudio()
    swipeStart.current = { x: e.clientX, y: e.clientY, idx: pageIdxRef.current }
  }
  const onAreaUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = swipeStart.current
    swipeStart.current = null
    const book = bookRef.current
    if (!s || !book || zoomIdx !== null) return
    const dx = e.clientX - s.x
    const dy = e.clientY - s.y
    // Left or right swipe, same rule both ways: a fairly quick, mostly horizontal move.
    if (Math.abs(dx) > 40 && Math.abs(dy) < 80 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      const forward = dx < 0
      // Wait one tick: page-flip handles the same pointerup on window after this React handler.
      window.setTimeout(() => {
        if (pageIdxRef.current !== s.idx || bookRef.current !== book) return
        if (forward) book.flipNext()
        else if (isTouchUI()) slidePrevRef.current?.()
        else book.flipPrev()
      }, 0)
    }
  }

  const toggleSound = () => {
    const next = !soundRef.current
    soundRef.current = next
    setSoundOn(next)
    saveSoundPref(next)
    if (next) {
      unlockAudio()
      playPageTurn()
    }
  }

  const goTo = (i: number) => bookRef.current?.turnToPage(i)
  const hasPages = total > 0
  const canPrev = pageIdx > 0
  const canNext = pageIdx < total - 1

  return (
    <div className="viewer">
      <header className="viewer-top">
        <div style={{ minWidth: 0 }}>
          <div className="viewer-title truncate" title={flipbook.title}>{flipbook.title}</div>
          <div className="viewer-meta">조회 {views.toLocaleString()}회</div>
        </div>
        <div className="viewer-top-actions">
          {hasPages && (
            <button
              type="button"
              className="btn btn-dark viewer-pill"
              onClick={toggleSound}
              aria-pressed={soundOn}
              aria-label={soundOn ? '넘김 소리 끄기' : '넘김 소리 켜기'}
            >
              {soundOn ? '🔊' : '🔇'}
            </button>
          )}
          {flipbook.pdf_url && (
            <a
              className="btn btn-dark viewer-pill"
              href={flipbook.pdf_url}
              target="_blank"
              rel="noopener"
              title="원본 PDF는 글자가 가장 선명해요"
            >
              PDF 원본
            </a>
          )}
        </div>
      </header>

      {hasPages && ratio !== null ? (
        <>
          <div
            ref={areaRef}
            className="book-area"
            onPointerDown={onAreaDown}
            onPointerUp={onAreaUp}
            onPointerCancel={() => { swipeStart.current = null }}
          >
            {!ready && <div className="book-loading" role="status">책을 준비하는 중...</div>}
          </div>

          {wide && (
            <nav className="thumbs" aria-label="페이지 목록">
              {pages.map((p, i) => (
                <button
                  key={p.page_no}
                  type="button"
                  className={`thumb${i === pageIdx ? ' is-current' : ''}`}
                  onClick={() => goTo(i)}
                  aria-label={`${p.page_no}페이지로 이동`}
                  aria-current={i === pageIdx ? 'page' : undefined}
                >
                  <img src={p.image_url} alt="" loading="lazy" decoding="async" />
                </button>
              ))}
            </nav>
          )}

          <div className="viewer-controls">
            <button
              type="button"
              className="nav-btn"
              onClick={() => (isTouchUI() ? slidePrevRef.current?.() : bookRef.current?.flipPrev())}
              disabled={!canPrev || !ready}
              aria-label="이전 페이지"
            >
              ‹
            </button>
            <div className="page-count" aria-live="polite">
              {pageIdx + 1} / {total}쪽
              <button type="button" className="zoom-open" onClick={() => setZoomIdx(pageIdx)}>
                🔍 확대
              </button>
            </div>
            <button
              type="button"
              className="nav-btn"
              onClick={() => bookRef.current?.flipNext()}
              disabled={!canNext || !ready}
              aria-label="다음 페이지"
            >
              ›
            </button>
          </div>
        </>
      ) : hasPages ? (
        <div className="viewer-empty" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
          <div className="book-loading" role="status">책을 준비하는 중...</div>
        </div>
      ) : (
        <div className="viewer-empty" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
          <div>이 카탈로그는 모바일 뷰어 이미지가 아직 없어요.</div>
          {flipbook.pdf_url && (
            <a className="btn btn-kakao" href={flipbook.pdf_url} target="_blank" rel="noopener">PDF 열기</a>
          )}
        </div>
      )}

      {zoomIdx !== null && (
        <ZoomView
          urls={urls}
          index={zoomIdx}
          onTurn={(delta) => {
            // Close the zoom view, then let the book curl to the next/previous page with its sound.
            const book = bookRef.current
            setZoomIdx(null)
            if (!book) return
            if (delta > 0) book.flipNext()
            else book.flipPrev()
          }}
          onClose={() => {
            // Closing the zoom view moves the book to the page the reader ended on.
            const target = zoomIdx
            setZoomIdx(null)
            if (target !== null && target !== pageIdxRef.current) bookRef.current?.turnToPage(target)
          }}
        />
      )}
    </div>
  )
}
