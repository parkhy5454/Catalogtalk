'use client'
import { useEffect, useRef, useState } from 'react'

const MIN_ZOOM = 1
const MAX_ZOOM = 4
const DOUBLE_TAP_ZOOM = 2.5

type Pt = { x: number; y: number }
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// Full-screen pinch-zoom for one page. Opened from the viewer's "확대" button.
export default function ZoomView({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const stageRef = useRef<HTMLDivElement>(null)
  const pointers = useRef(new Map<number, Pt>())
  const g = useRef({ start: { x: 0, y: 0 } as Pt, startPan: { x: 0, y: 0 } as Pt, startZoom: 1, startDist: 0, pinched: false, moved: false, t: 0 })
  const lastTap = useRef<{ t: number; p: Pt } | null>(null)
  const [zoom, setZoom] = useState(MIN_ZOOM)
  const [pan, setPan] = useState<Pt>({ x: 0, y: 0 })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

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
    if (!s.moved && Date.now() - s.t < 300) {
      const now = Date.now()
      const last = lastTap.current
      if (last && now - last.t < 300 && dist(last.p, { x: e.clientX, y: e.clientY }) < 30) {
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
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          draggable={false}
          className="zoom-img"
          style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})` }}
        />
      </div>
      <div className="zoom-hint">두 손가락으로 확대 · 두 번 탭 · 닫기로 돌아가기</div>
    </div>
  )
}
