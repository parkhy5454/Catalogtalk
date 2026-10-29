'use client'
import { useEffect, useRef, useState } from 'react'
import { playPageTurn } from '@/lib/flipbook/sound'

const MIN_ZOOM = 1
const MAX_ZOOM = 4
const DOUBLE_TAP_ZOOM = 2.5

type Pt = { x: number; y: number }
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// Full-screen pinch-zoom viewer for the catalog pages. Opened from the viewer's "확대" button.
// Pages can be changed here too: ‹ › buttons, a horizontal swipe (when not zoomed), or arrow keys.
export default function ZoomView({
  urls,
  index,
  onIndexChange,
  onClose,
  soundOn,
}: {
  urls: string[]
  index: number
  onIndexChange: (i: number) => void
  onClose: () => void
  soundOn: boolean
}) {
  const stageRef = useRef<HTMLDivElement>(null)
  const pointers = useRef(new Map<number, Pt>())
  const g = useRef({
    start: { x: 0, y: 0 } as Pt,
    startPan: { x: 0, y: 0 } as Pt,
    startZoom: 1,
    startDist: 0,
    pinched: false,
    moved: false,
    t: 0,
    edgeLeft: false, // zoomed and already showing the left edge when the drag started
    edgeRight: false, // zoomed and already showing the right edge when the drag started
  })
  const lastTap = useRef<{ t: number; p: Pt } | null>(null)
  const [zoom, setZoom] = useState(MIN_ZOOM)
  const [pan, setPan] = useState<Pt>({ x: 0, y: 0 })
  const [dir, setDir] = useState(0) // +1 next, -1 prev, 0 on open: drives the slide-in

  const last = urls.length - 1
  const go = (delta: number) => {
    const next = clamp(index + delta, 0, last)
    if (next === index) return
    setDir(delta)
    if (soundOn) playPageTurn()
    onIndexChange(next)
  }

  // A new page always starts unzoomed.
  useEffect(() => {
    setZoom(MIN_ZOOM)
    setPan({ x: 0, y: 0 })
  }, [index])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight') go(1)
      if (e.key === 'ArrowLeft') go(-1)
    }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose, index, last, soundOn]) // eslint-disable-line react-hooks/exhaustive-deps

  const clampPan = (p: Pt, z: number): Pt => {
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect) return p
    const mx = ((z - 1) * rect.width) / 2
    const my = ((z - 1) * rect.height) / 2
    return { x: clamp(p.x, -mx, mx), y: clamp(p.y, -my, my) }
  }

  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    stageRef.current?.setPointerCapture?.(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const s = g.current
    if (pointers.current.size === 1) {
      s.start = { x: e.clientX, y: e.clientY }
      s.startPan = pan
      s.startZoom = zoom
      s.pinched = false
      s.moved = false
      s.t = Date.now()
      const rect = stageRef.current?.getBoundingClientRect()
      const mx = rect && zoom > 1 ? ((zoom - 1) * rect.width) / 2 : 0
      s.edgeLeft = mx > 0 && pan.x >= mx - 2
      s.edgeRight = mx > 0 && pan.x <= -mx + 2
    } else if (pointers.current.size === 2) {
      const [a, b] = Array.from(pointers.current.values())
      s.startDist = dist(a, b)
      s.startZoom = zoom
      s.pinched = true
    }
  }

  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const s = g.current
    if (pointers.current.size >= 2) {
      const [a, b] = Array.from(pointers.current.values())
      const nz = clamp((s.startZoom * dist(a, b)) / (s.startDist || 1), MIN_ZOOM, MAX_ZOOM)
      setZoom(nz)
      setPan((p) => clampPan(p, nz))
      return
    }
    const dx = e.clientX - s.start.x
    const dy = e.clientY - s.start.y
    if (Math.hypot(dx, dy) > 10) s.moved = true
    if (zoom > 1) setPan(clampPan({ x: s.startPan.x + dx, y: s.startPan.y + dy }, zoom))
  }

  const up = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.delete(e.pointerId)
    const s = g.current
    if (pointers.current.size > 0) return
    if (s.pinched) {
      if (zoom < 1.05) {
        setZoom(MIN_ZOOM)
        setPan({ x: 0, y: 0 })
      }
      s.pinched = false
      return
    }
    // Horizontal swipe turns the page: anywhere at normal zoom, and when zoomed only once
    // the picture is already at the side the reader is pushing toward.
    if (s.moved) {
      const dx = e.clientX - s.start.x
      const dy = e.clientY - s.start.y
      if (Math.abs(dx) > 50 && Math.abs(dx) > 1.5 * Math.abs(dy)) {
        if (zoom <= 1.05) go(dx < 0 ? 1 : -1)
        else if (dx < 0 && s.edgeRight) go(1)
        else if (dx > 0 && s.edgeLeft) go(-1)
      }
      return
    }
    if (!s.moved && Date.now() - s.t < 300) {
      const now = Date.now()
      const lt = lastTap.current
      if (lt && now - lt.t < 300 && dist(lt.p, { x: e.clientX, y: e.clientY }) < 30) {
        lastTap.current = null
        setZoom(zoom > 1 ? MIN_ZOOM : DOUBLE_TAP_ZOOM)
        setPan({ x: 0, y: 0 })
      } else {
        lastTap.current = { t: now, p: { x: e.clientX, y: e.clientY } }
      }
    }
  }

  return (
    <div className="zoom-layer" role="dialog" aria-modal="true" aria-label="페이지 확대 보기">
      <button type="button" className="zoom-close" onClick={onClose} aria-label="확대 보기 닫기">
        닫기 ✕
      </button>
      <div
        ref={stageRef}
        className="zoom-stage"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        {/* Keyed by page so each page slides in from the side it was turned from. */}
        <div key={index} className="zoom-page" style={{ ['--dir' as string]: dir }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={urls[index]}
            alt={`${index + 1}페이지 확대`}
            draggable={false}
            className="zoom-img"
            style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})` }}
          />
        </div>
      </div>
      <button
        type="button"
        className="zoom-nav zoom-nav-prev"
        onClick={() => go(-1)}
        disabled={index <= 0}
        aria-label="이전 페이지"
      >
        ‹
      </button>
      <button
        type="button"
        className="zoom-nav zoom-nav-next"
        onClick={() => go(1)}
        disabled={index >= last}
        aria-label="다음 페이지"
      >
        ›
      </button>
      <div className="zoom-count" aria-live="polite">{index + 1} / {urls.length}쪽</div>
      <div className="zoom-hint">두 손가락으로 확대 · 좌우로 밀어 넘기기 · 닫기로 돌아가기</div>
    </div>
  )
}
