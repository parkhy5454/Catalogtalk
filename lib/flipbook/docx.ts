// Word (.docx) -> page images, so a .docx gets the same mobile flipbook viewer as a PDF.
// 1. mammoth turns the .docx into HTML.
// 2. The HTML is laid out on A4-sized sheets in the browser and split between blocks
//    (paragraphs, tables, images) so no block is cut in half.
// 3. html2canvas paints each sheet, and convert.ts encodes it as WebP like PDF pages.
// Runs in the uploader's browser only (dynamically imported from the dashboard).
import mammoth from 'mammoth'
import html2canvas from 'html2canvas'
import { canvasToBlob, canvasToJpeg, type RenderedPage, type RenderResult } from '@/lib/flipbook/convert'

const PAGE_W = 794 // A4 at 96 dpi, in CSS px
const PAGE_H = 1123
const MARGIN = 72 // about 19 mm
const CONTENT_W = PAGE_W - MARGIN * 2
const CONTENT_H = PAGE_H - MARGIN * 2
const SCALE = 2 // 794 x 2 is about 1588 px wide, close to the PDF renderer's target width
const FONT = '"Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif'
const DOC_CLASS = 'docx-doc'

let styleInjected = false
function injectStyle() {
  if (styleInjected) return
  styleInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .${DOC_CLASS} { font-family: ${FONT}; font-size: 14px; line-height: 1.7; color: #111; background: #fff; }
    .${DOC_CLASS} p { margin: 0 0 0.6em; }
    .${DOC_CLASS} h1, .${DOC_CLASS} h2, .${DOC_CLASS} h3 { margin: 0.8em 0 0.4em; line-height: 1.35; font-weight: 700; }
    .${DOC_CLASS} h1 { font-size: 24px; }
    .${DOC_CLASS} h2 { font-size: 20px; }
    .${DOC_CLASS} h3 { font-size: 17px; }
    .${DOC_CLASS} ul, .${DOC_CLASS} ol { margin: 0 0 0.6em; padding-left: 1.4em; }
    .${DOC_CLASS} table { border-collapse: collapse; width: 100%; margin: 0 0 0.8em; }
    .${DOC_CLASS} td, .${DOC_CLASS} th { border: 1px solid #bbb; padding: 4px 6px; vertical-align: top; }
    .${DOC_CLASS} img { display: block; max-width: 100%; max-height: 900px; height: auto; margin: 0 auto 0.6em; }
  `
  document.head.appendChild(style)
}

function blockHeight(el: HTMLElement): number {
  const cs = getComputedStyle(el)
  // Margins are not collapsed here, so the estimate is slightly high: that only adds a page.
  return el.offsetHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0)
}

function waitForImages(root: HTMLElement): Promise<void[]> {
  return Promise.all(
    Array.from(root.querySelectorAll('img')).map((img) =>
      img.complete
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            img.onload = () => resolve()
            img.onerror = () => resolve()
          })
    )
  )
}

function buildSheet(nodes: HTMLElement[]): HTMLElement {
  const sheet = document.createElement('div')
  sheet.className = DOC_CLASS
  sheet.style.cssText = `position:absolute;left:-10000px;top:0;width:${PAGE_W}px;height:${PAGE_H}px;box-sizing:border-box;padding:${MARGIN}px;overflow:hidden;`
  for (const n of nodes) sheet.appendChild(n.cloneNode(true))
  return sheet
}

/** Render a .docx file to page images (same result shape as renderPdfPages). */
export async function renderDocxPages(
  source: ArrayBuffer,
  onPage?: (done: number, total: number) => void
): Promise<RenderResult> {
  injectStyle()
  const { value: html } = await mammoth.convertToHtml({ arrayBuffer: source })

  const measure = document.createElement('div')
  measure.className = DOC_CLASS
  measure.style.cssText = `position:absolute;left:-10000px;top:0;width:${CONTENT_W}px;`
  measure.innerHTML = html
  document.body.appendChild(measure)

  try {
    await waitForImages(measure)
    const blocks = Array.from(measure.children) as HTMLElement[]
    if (blocks.length === 0) throw new Error('문서에 내용이 없어요')

    // Greedy paging: start a new sheet when the next block would overflow.
    const groups: HTMLElement[][] = [[]]
    let used = 0
    for (const block of blocks) {
      const h = blockHeight(block)
      if (used + h > CONTENT_H && groups[groups.length - 1].length > 0) {
        groups.push([])
        used = 0
      }
      groups[groups.length - 1].push(block)
      used += h
    }

    const pages: RenderedPage[] = []
    let thumbJpg: Blob | null = null
    for (let i = 0; i < groups.length; i++) {
      const sheet = buildSheet(groups[i])
      document.body.appendChild(sheet)
      try {
        const canvas = await html2canvas(sheet, {
          scale: SCALE,
          backgroundColor: '#ffffff',
          useCORS: true,
          logging: false,
        })
        const { blob, ext } = await canvasToBlob(canvas)
        pages.push({ pageNo: i + 1, blob, ext })
        if (i === 0) thumbJpg = await canvasToJpeg(canvas)
        canvas.width = canvas.height = 0 // free memory before the next sheet
      } finally {
        sheet.remove()
      }
      onPage?.(i + 1, groups.length)
    }

    if (!thumbJpg) throw new Error('문서를 이미지로 바꾸지 못했어요')
    return { numPages: pages.length, pages, thumbJpg }
  } finally {
    measure.remove()
  }
}
