// Browser-side helpers for creating and (re)converting flipbooks.
// Everything here runs with the signed-in user's session, so RLS applies.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { RenderResult } from '@/lib/flipbook/convert'

export const BUCKET = 'flipbook-files'
export const MAX_PDF_BYTES = 50 * 1024 * 1024 // applies to every supported source file

export type SourceKind = 'pdf' | 'docx'
const SOURCE_MIME: Record<SourceKind, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

/** Which converter a file needs, or null if it is not supported (HWP must be saved as PDF first). */
export function sourceKindOf(name: string): SourceKind | null {
  if (/\.pdf$/i.test(name)) return 'pdf'
  if (/\.docx$/i.test(name)) return 'docx'
  return null
}
const UPLOAD_CONCURRENCY = 4
const ASSET_CACHE = '31536000' // 1 year: asset paths are unique per slug + page

export type FlipbookRow = {
  id: string
  title: string
  slug: string
  pdf_url: string | null
  thumb_url: string | null
  page_count: number
  views: number
  created_at: string
  is_public: boolean
  folder_id: string | null
}

export function makeSlug(): string {
  // catalog-{timestamp}-{random}: ASCII only, so it is safe in URLs and never collides in practice.
  return `catalog-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

function pageName(pageNo: number, ext: string) {
  return `p-${String(pageNo).padStart(4, '0')}.${ext}`
}

export function publicUrl(supabase: SupabaseClient, path: string): string {
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl
}

/** Run async tasks with a fixed concurrency limit (keeps phones from stalling on many uploads). */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      await fn(items[i])
    }
  })
  await Promise.all(workers)
}

type Pages = { pageNo: number; blob: Blob; ext: 'webp' | 'jpg' }[]
type Render = (buf: ArrayBuffer, onPage: (d: number, t: number) => void) => Promise<RenderResult>

/** Upload the JPEG thumbnail used by OpenGraph / Kakao previews. Returns its public URL. */
async function uploadThumb(supabase: SupabaseClient, slug: string, blob: Blob) {
  const path = `${slug}/thumb.jpg`
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, {
    contentType: 'image/jpeg',
    cacheControl: ASSET_CACHE,
    upsert: true,
  })
  if (error) throw new Error(`썸네일 업로드 실패: ${error.message}`)
  return publicUrl(supabase, path)
}

/** Upload rendered page images and return their public URLs in page order. */
async function uploadPages(supabase: SupabaseClient, slug: string, pages: Pages, onProgress?: (done: number, total: number) => void) {
  const urls: Record<number, string> = {}
  let done = 0
  await mapLimit(pages, UPLOAD_CONCURRENCY, async (p) => {
    const path = `${slug}/${pageName(p.pageNo, p.ext)}`
    const { error } = await supabase.storage.from(BUCKET).upload(path, p.blob, {
      contentType: p.ext === 'webp' ? 'image/webp' : 'image/jpeg',
      cacheControl: ASSET_CACHE,
      upsert: true,
    })
    if (error) throw new Error(`페이지 ${p.pageNo} 업로드 실패: ${error.message}`)
    urls[p.pageNo] = publicUrl(supabase, path)
    done++
    onProgress?.(done, pages.length)
  })
  return pages.map((p) => ({ pageNo: p.pageNo, url: urls[p.pageNo] }))
}

async function insertPages(supabase: SupabaseClient, flipbookId: string, pages: { pageNo: number; url: string }[]) {
  const CHUNK = 100
  for (let i = 0; i < pages.length; i += CHUNK) {
    const rows = pages.slice(i, i + CHUNK).map((p) => ({
      flipbook_id: flipbookId,
      page_no: p.pageNo,
      image_url: p.url,
    }))
    const { error } = await supabase.from('flipbook_pages').upsert(rows, { onConflict: 'flipbook_id,page_no' })
    if (error) throw error
  }
}

/** Convert a brand-new PDF into a flipbook (pages + thumbnail + DB rows). */
export async function createFlipbook(
  supabase: SupabaseClient,
  opts: { userId: string; title: string; file: File; folderId?: string | null },
  render: Render,
  onStatus: (text: string, progress: number) => void
): Promise<FlipbookRow> {
  const kind = sourceKindOf(opts.file.name)
  if (!kind) throw new Error('PDF 또는 Word(.docx) 파일만 올릴 수 있어요')
  const slug = makeSlug()
  const buf = await opts.file.arrayBuffer()

  onStatus('페이지를 이미지로 변환하는 중...', 0)
  const { numPages, pages, thumbJpg } = await render(buf.slice(0), (d, t) => onStatus(`페이지 변환 중 ${d} / ${t}`, d / t * 0.4))

  onStatus('원본 파일 저장 중...', 0.42)
  // The original is public like the page images, but its file name carries an unguessable token,
  // so the address cannot be guessed from the catalog link.
  const originalPath = `${slug}/original-${crypto.randomUUID().replace(/-/g, '')}.${kind}`
  const { error: srcErr } = await supabase.storage.from(BUCKET).upload(originalPath, opts.file, {
    contentType: SOURCE_MIME[kind],
    cacheControl: ASSET_CACHE,
    upsert: false,
  })
  if (srcErr) throw new Error(`원본 파일 업로드 실패: ${srcErr.message}`)

  onStatus('페이지 이미지 업로드 중...', 0.45)
  const uploaded = await uploadPages(supabase, slug, pages, (d, t) =>
    onStatus(`이미지 업로드 중 ${d} / ${t}`, 0.45 + (d / t) * 0.45)
  )

  onStatus('저장 중...', 0.95)
  const pdfUrl = publicUrl(supabase, originalPath)
  const thumbUrl = await uploadThumb(supabase, slug, thumbJpg)

  const { data: fb, error } = await supabase
    .from('flipbooks')
    .insert({
      user_id: opts.userId,
      title: opts.title,
      slug,
      pdf_url: pdfUrl,
      thumb_url: thumbUrl,
      page_count: numPages,
      folder_id: opts.folderId ?? null,
    })
    .select('id, title, slug, pdf_url, thumb_url, page_count, views, created_at, folder_id, is_public')
    .single()
  if (error) throw error

  try {
    await insertPages(supabase, fb.id, uploaded)
  } catch (e) {
    // Roll back so the list never shows a flipbook without pages.
    await supabase.from('flipbooks').delete().eq('id', fb.id)
    throw e
  }

  onStatus('완료!', 1)
  return fb as FlipbookRow
}

/** Build mobile page images for an older catalog that only has its original PDF. */
export async function convertExisting(
  supabase: SupabaseClient,
  fb: FlipbookRow,
  render: Render,
  onStatus: (text: string, progress: number) => void
): Promise<void> {
  if (!fb.pdf_url) throw new Error('원본 PDF 주소가 없어요')
  onStatus('원본 PDF 불러오는 중...', 0)
  const res = await fetch(fb.pdf_url)
  if (!res.ok) throw new Error('원본 PDF를 불러오지 못했어요')
  const buf = await res.arrayBuffer()

  const { numPages, pages, thumbJpg } = await render(buf, (d, t) => onStatus(`페이지 변환 중 ${d} / ${t}`, d / t * 0.5))
  // Storage folder = row id (ASCII UUID). Legacy slugs can contain Korean, and Supabase
  // Storage rejects such object keys with 400. The public slug (URL) stays unchanged.
  const folder = fb.id
  const uploaded = await uploadPages(supabase, folder, pages, (d, t) =>
    onStatus(`이미지 업로드 중 ${d} / ${t}`, 0.5 + (d / t) * 0.45)
  )
  const thumbUrl = await uploadThumb(supabase, folder, thumbJpg)

  await insertPages(supabase, fb.id, uploaded)
  const { error } = await supabase
    .from('flipbooks')
    .update({ page_count: numPages, thumb_url: thumbUrl })
    .eq('id', fb.id)
  if (error) throw error
  onStatus('완료!', 1)
}

/** Storage path (inside the bucket) for a public URL created by publicUrl(). */
function pathFromPublicUrl(url: string | null): string | null {
  if (!url) return null
  const marker = `/${BUCKET}/`
  const i = url.indexOf(marker)
  if (i < 0) return null
  try {
    return decodeURIComponent(url.slice(i + marker.length).split('?')[0])
  } catch {
    return null
  }
}

/** List every file under a folder in the bucket (best effort). */
async function listFolder(supabase: SupabaseClient, folder: string): Promise<string[]> {
  const { data, error } = await supabase.storage.from(BUCKET).list(folder, { limit: 1000 })
  if (error || !data) return []
  return data.filter((f) => f.name && f.id !== null).map((f) => `${folder}/${f.name}`)
}

/**
 * Delete a flipbook: its database row (pages and view logs cascade) and its files in storage.
 * The DB delete is authoritative; storage cleanup is best effort so a leftover file
 * never blocks removing the catalog from the list.
 */
export async function deleteFlipbook(supabase: SupabaseClient, fb: FlipbookRow): Promise<void> {
  const { error } = await supabase.from('flipbooks').delete().eq('id', fb.id)
  if (error) throw error

  const paths: string[] = []
  for (const folder of [fb.slug, fb.id]) {
    paths.push(...(await listFolder(supabase, folder)))
  }
  const original = pathFromPublicUrl(fb.pdf_url)
  if (original) paths.push(original) // legacy PDFs sit at the bucket root
  const unique = paths.filter((p, i) => paths.indexOf(p) === i)
  if (unique.length > 0) {
    await supabase.storage.from(BUCKET).remove(unique).catch(() => undefined)
  }

}
