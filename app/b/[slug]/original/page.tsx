'use client'
// Original PDF inside the app, with a way back to the viewer. Word (.docx) originals cannot
// be drawn here, so they get a download button instead.
import { useEffect, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

const PDFJS_VERSION = '3.11.174'
const PDFJS_BASE = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}`
const DOCX_RE = /\.docx(\?|$)/i

type Book = { title: string; slug: string; pdf_url: string | null }

export default function OriginalPage() {
  const { slug } = useParams<{ slug: string }>()
  // undefined = still loading, null = not found
  const [book, setBook] = useState<Book | null | undefined>(undefined)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const holder = useRef<HTMLDivElement>(null)

  useEffect(() => {
    createClient()
      .rpc('get_flipbook', { p_slug: slug })
      .then(({ data }) => {
        const row = Array.isArray(data) ? data[0] : null
        setBook(row ? { title: row.title, slug: row.slug, pdf_url: row.pdf_url } : null)
      })
  }, [slug])

  useEffect(() => {
    if (!book || !book.pdf_url || DOCX_RE.test(book.pdf_url)) return
    const pdfUrl = book.pdf_url
    let cancelled = false
    if (holder.current) holder.current.innerHTML = ''
    ;(async () => {
      try {
        setStatus('원본을 불러오는 중...')
        const pdfjs = await import('pdfjs-dist/build/pdf')
        pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/pdf.worker.min.js`
        const doc = await pdfjs.getDocument({
          url: pdfUrl,
          cMapUrl: `${PDFJS_BASE}/cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `${PDFJS_BASE}/standard_fonts/`,
        }).promise
        const width = Math.min(holder.current?.clientWidth || window.innerWidth, 1000)
        for (let n = 1; n <= doc.numPages; n++) {
          if (cancelled) return
          const page = await doc.getPage(n)
          const base = page.getViewport({ scale: 1 })
          const vp = page.getViewport({ scale: (width * (window.devicePixelRatio || 1)) / base.width })
          const canvas = document.createElement('canvas')
          canvas.width = Math.floor(vp.width)
          canvas.height = Math.floor(vp.height)
          canvas.style.width = '100%'
          canvas.style.display = 'block'
          canvas.style.marginBottom = '10px'
          const ctx = canvas.getContext('2d')
          if (!ctx) throw new Error('화면을 그릴 수 없어요')
          await page.render({ canvasContext: ctx, viewport: vp }).promise
          holder.current?.appendChild(canvas)
          setStatus(`${n} / ${doc.numPages}쪽`)
        }
        if (!cancelled) setStatus('')
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : '원본을 열지 못했어요')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [book])

  const isDocx = !!book?.pdf_url && DOCX_RE.test(book.pdf_url)

  return (
    <div style={{ minHeight: '100dvh', background: '#2b2b2b', color: '#fff' }}>
      <header
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 5,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          // Start below the iPhone status bar / notch (the app draws behind it).
          padding: 'calc(env(safe-area-inset-top, 0px) + 12px) 14px 12px',
          background: '#000',
        }}
      >
        <a className="btn btn-dark viewer-pill" href={`/b/${slug}`}>
          ← 뷰어로
        </a>
        <div className="truncate" style={{ flex: 1, minWidth: 0, fontWeight: 700 }}>
          {book?.title ?? '원본 파일'}
        </div>
      </header>

      <main style={{ padding: 12 }}>
        {book === undefined && <div style={{ color: '#bbb' }}>불러오는 중...</div>}
        {book === null && <div style={{ color: '#bbb' }}>플립북을 찾을 수 없어요.</div>}
        {book && isDocx && (
          <div style={{ textAlign: 'center', marginTop: 48 }}>
            <p style={{ color: '#ccc', marginBottom: 16 }}>Word 원본은 앱 안에서 볼 수 없어요.</p>
            <a className="btn btn-primary" href={book.pdf_url!} target="_blank" rel="noopener">
              원본 파일 내려받기
            </a>
          </div>
        )}
        {book && !book.pdf_url && <div style={{ color: '#bbb' }}>원본 파일이 없어요.</div>}
        {error && <div className="notice notice-error">{error}</div>}
        {status && <div style={{ fontSize: 13, color: '#bbb', margin: '8px 0' }}>{status}</div>}
        <div ref={holder} />
      </main>
    </div>
  )
}
