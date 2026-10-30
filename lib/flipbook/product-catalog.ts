// Builds a new catalog from selected products: each page is drawn on a canvas (photo, name, price,
// options, description in a grid) and stored like any other catalog's page images.
import type { SupabaseClient } from '@supabase/supabase-js'
import { PRIVATE_BUCKET, PRIVATE_PREFIX, PUBLIC_BUCKET } from '@/lib/flipbook/storage'
import { makeSlug, publicUrl, type FlipbookRow } from '@/lib/flipbook/upload'

export type CatalogProduct = {
  name: string
  price: number | null
  unit: string | null
  options: string | null
  description: string | null
  image_url: string | null
}

const W = 900
const H = 1273 // A4 proportion
const MARGIN = 48
const GAP = 24
const COLS = 2
const ROWS = 3
const PER_PAGE = COLS * ROWS
export const MAX_PRODUCTS_PER_NEW_CATALOG = 120
const IMG_TIMEOUT_MS = 8000

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const el = new Image()
    el.crossOrigin = 'anonymous'
    const timer = setTimeout(() => resolve(null), IMG_TIMEOUT_MS)
    el.onload = () => { clearTimeout(timer); resolve(el) }
    el.onerror = () => { clearTimeout(timer); resolve(null) }
    el.src = url
  })
}

// Wraps text by measuring each character; stops after maxLines and adds an ellipsis.
function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const ch of text) {
    const next = line + ch
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line)
      line = ch
      if (lines.length === maxLines) break
    } else {
      line = next
    }
  }
  if (lines.length < maxLines && line) lines.push(line)
  if (lines.length === maxLines && (line || lines.join('').length < text.length)) {
    const last = lines[maxLines - 1]
    lines[maxLines - 1] = last.length > 1 ? `${last.slice(0, -1)}…` : '…'
  }
  return lines
}

const won = (n: number) => `${n.toLocaleString('ko-KR')}원`

async function drawPage(
  products: CatalogProduct[],
  pageNo: number,
  title: string,
  pageTotal: number,
  photos: (HTMLImageElement | null)[]
): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('카탈로그 페이지를 그리지 못했어요')

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, W, H)
  const top = MARGIN + (pageNo === 1 ? 120 : 0)
  const bottom = 64
  if (pageNo === 1) {
    ctx.fillStyle = '#111111'
    ctx.font = 'bold 44px system-ui, sans-serif'
    ctx.fillText(title, MARGIN, MARGIN + 52, W - MARGIN * 2)
    ctx.fillStyle = '#777777'
    ctx.font = '24px system-ui, sans-serif'
    ctx.fillText('신제품 소개', MARGIN, MARGIN + 92)
  }

  const cellW = (W - MARGIN * 2 - GAP * (COLS - 1)) / COLS
  const cellH = (H - top - bottom - GAP * (ROWS - 1)) / ROWS
  const photoH = Math.round(cellH * 0.56)

  products.forEach((p, i) => {
    const col = i % COLS
    const row = Math.floor(i / COLS)
    const x = MARGIN + col * (cellW + GAP)
    const y = top + row * (cellH + GAP)

    // Photo area (cover-fit), or a plain box with the name when there is no photo.
    ctx.fillStyle = '#f3f3f1'
    ctx.fillRect(x, y, cellW, photoH)
    const img = photos[i]
    if (img) {
      const scale = Math.max(cellW / img.width, photoH / img.height)
      const sw = cellW / scale
      const sh = photoH / scale
      const sx = (img.width - sw) / 2
      const sy = (img.height - sh) / 2
      ctx.drawImage(img, sx, sy, sw, sh, x, y, cellW, photoH)
    }

    let ty = y + photoH + 36
    ctx.fillStyle = '#111111'
    ctx.font = 'bold 30px system-ui, sans-serif'
    for (const line of wrap(ctx, p.name, cellW, 2)) {
      ctx.fillText(line, x, ty)
      ty += 38
    }
    ctx.fillStyle = '#c0392b'
    ctx.font = 'bold 26px system-ui, sans-serif'
    const priceText = p.price === null ? '가격 문의' : `${won(p.price)}${p.unit ? ` / ${p.unit}` : ''}`
    ctx.fillText(priceText, x, ty + 4)
    ty += 42
    ctx.fillStyle = '#666666'
    ctx.font = '22px system-ui, sans-serif'
    if (p.options) {
      for (const line of wrap(ctx, p.options, cellW, 1)) {
        ctx.fillText(line, x, ty)
        ty += 30
      }
    }
    if (p.description) {
      for (const line of wrap(ctx, p.description, cellW, 3)) {
        ctx.fillText(line, x, ty)
        ty += 30
      }
    }
  })

  ctx.fillStyle = '#999999'
  ctx.font = '20px system-ui, sans-serif'
  const pageText = `${pageNo} / ${pageTotal}`
  ctx.fillText(pageText, W - MARGIN - ctx.measureText(pageText).width, H - 28)

  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('페이지를 저장하지 못했어요'))), 'image/jpeg', 0.9)
  )
}

/** Creates a new catalog from products. Returns the new catalog row. */
export async function createCatalogFromProducts(
  supabase: SupabaseClient,
  opts: { userId: string; title: string; products: CatalogProduct[] },
  onStatus: (text: string) => void
): Promise<FlipbookRow> {
  if (opts.products.length === 0) throw new Error('상품을 골라 주세요')
  if (opts.products.length > MAX_PRODUCTS_PER_NEW_CATALOG) {
    throw new Error(`한 번에 ${MAX_PRODUCTS_PER_NEW_CATALOG}개까지 담을 수 있어요`)
  }
  const slug = makeSlug()
  const groups: CatalogProduct[][] = []
  for (let i = 0; i < opts.products.length; i += PER_PAGE) groups.push(opts.products.slice(i, i + PER_PAGE))

  onStatus('사진을 불러오는 중...')
  const photosAll = await Promise.all(opts.products.map((p) => (p.image_url ? loadImage(p.image_url) : Promise.resolve(null))))

  const blobs: Blob[] = []
  let cursor = 0
  for (let g = 0; g < groups.length; g++) {
    onStatus(`페이지 그리는 중 ${g + 1} / ${groups.length}`)
    const photos = photosAll.slice(cursor, cursor + groups[g].length)
    cursor += groups[g].length
    blobs.push(await drawPage(groups[g], g + 1, opts.title, groups.length, photos))
  }

  onStatus('이미지 업로드 중...')
  const paths: string[] = []
  for (let g = 0; g < blobs.length; g++) {
    const path = `${slug}/gen-${g + 1}.jpg`
    const { error } = await supabase.storage.from(PRIVATE_BUCKET).upload(path, blobs[g], {
      contentType: 'image/jpeg', cacheControl: '31536000', upsert: false,
    })
    if (error) throw new Error(`페이지 ${g + 1} 업로드 실패: ${error.message}`)
    paths.push(path)
  }
  const thumbPath = `${slug}/thumb.jpg`
  const thumbUp = await supabase.storage.from(PUBLIC_BUCKET).upload(thumbPath, blobs[0], {
    contentType: 'image/jpeg', cacheControl: '31536000', upsert: false,
  })
  const thumbUrl = thumbUp.error ? null : publicUrl(supabase, thumbPath)

  onStatus('저장 중...')
  const { data: fb, error } = await supabase
    .from('flipbooks')
    .insert({ user_id: opts.userId, title: opts.title, slug, pdf_url: null, thumb_url: thumbUrl, page_count: blobs.length, folder_id: null })
    .select('id, title, slug, pdf_url, thumb_url, page_count, views, created_at, folder_id, is_public')
    .single()
  if (error) throw error

  const rows = paths.map((path, i) => ({ flipbook_id: fb.id, page_no: i + 1, image_url: PRIVATE_PREFIX + path }))
  const { error: pageErr } = await supabase.from('flipbook_pages').upsert(rows, { onConflict: 'flipbook_id,page_no' })
  if (pageErr) {
    await supabase.from('flipbooks').delete().eq('id', fb.id)
    throw pageErr
  }
  return fb as FlipbookRow
}
