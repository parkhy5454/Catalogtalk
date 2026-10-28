// Client-side PDF -> WebP page images using pdf.js.
// Runs in the browser of the uploader (desktop or mobile); the viewer never runs pdf.js.
import * as pdfjsLib from 'pdfjs-dist/build/pdf'

const PDFJS_VERSION = '3.11.174'
const TARGET_WIDTH = 1200 // px; crisp on 3x phones, small enough to stay light
const WEBP_QUALITY = 0.82

let workerReady = false
function ensureWorker() {
  if (workerReady) return
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.js`
  workerReady = true
}

export type RenderedPage = { pageNo: number; blob: Blob; ext: 'webp' | 'jpg' }

export type RenderResult = {
  numPages: number
  pages: RenderedPage[]
  /** JPEG of page 1: Kakao / OpenGraph crawlers are most reliable with JPEG. */
  thumbJpg: Blob
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<{ blob: Blob; ext: 'webp' | 'jpg' }> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (webp) => {
        if (webp && webp.type === 'image/webp') return resolve({ blob: webp, ext: 'webp' })
        // Some older Safari/in-app webviews cannot encode WebP; fall back to JPEG.
        canvas.toBlob(
          (jpg) => (jpg ? resolve({ blob: jpg, ext: 'jpg' }) : reject(new Error('이미지 변환에 실패했어요'))),
          'image/jpeg',
          0.85
        )
      },
      'image/webp',
      WEBP_QUALITY
    )
  })
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('썸네일 생성에 실패했어요'))),
      'image/jpeg',
      0.85
    )
  )
}

/**
 * Render every page of a PDF to an image.
 * `onPage` is called after each page so the UI can show progress.
 * The first rendered page doubles as the OpenGraph / Kakao thumbnail.
 */
export async function renderPdfPages(
  source: ArrayBuffer,
  onPage?: (done: number, total: number) => void
): Promise<RenderResult> {
  ensureWorker()
  const pdf = await pdfjsLib.getDocument({ data: source }).promise
  const pages: RenderedPage[] = []
  let thumbJpg: Blob | null = null

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const base = page.getViewport({ scale: 1 })
    const scale = TARGET_WIDTH / base.width
    const viewport = page.getViewport({ scale })

    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('캔버스를 사용할 수 없어요')
    ctx.fillStyle = '#ffffff' // PDFs can have transparent backgrounds
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    await page.render({ canvasContext: ctx, viewport }).promise
    const { blob, ext } = await canvasToBlob(canvas)
    pages.push({ pageNo: i, blob, ext })
    if (i === 1) thumbJpg = await canvasToJpeg(canvas)

    // Free memory before the next page (matters on phones).
    canvas.width = canvas.height = 0
    page.cleanup()
    onPage?.(i, pdf.numPages)
  }

  await pdf.destroy()
  if (!thumbJpg) throw new Error('PDF에 페이지가 없어요')
  return { numPages: pages.length, pages, thumbJpg }
}
