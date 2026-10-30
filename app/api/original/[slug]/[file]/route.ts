import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// Serves a catalog's original file through a short-lived signed link. Originals sit in a
// private bucket, so nobody gets a permanent storage URL. Legacy catalogs (uploaded before
// this change) keep their public URL and are redirected to it.
export const dynamic = 'force-dynamic'

const ORIGINALS_BUCKET = 'flipbook-originals'
const SIGNED_SECONDS = 600
const SLUG_RE = /^[a-z0-9-]{4,80}$/i
const FILE_RE = /^original\.(pdf|docx)$/
const NO_CACHE = { 'Cache-Control': 'no-store, max-age=0' }

export async function GET(_req: Request, { params }: { params: { slug: string; file: string } }) {
  const { slug, file } = params
  if (!SLUG_RE.test(slug) || !FILE_RE.test(file)) {
    return new NextResponse('Not found', { status: 404 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return new NextResponse('Server not configured', { status: 500 })

  const admin = createClient(url, key, { auth: { persistSession: false } })
  const { data: fb } = await admin
    .from('flipbooks')
    .select('pdf_url')
    .eq('slug', slug)
    .maybeSingle()
  if (!fb) return new NextResponse('Not found', { status: 404 })

  if (fb.pdf_url && !fb.pdf_url.startsWith('/api/original/')) {
    return NextResponse.redirect(fb.pdf_url, { status: 302, headers: NO_CACHE })
  }

  const { data, error } = await admin.storage
    .from(ORIGINALS_BUCKET)
    .createSignedUrl(`${slug}/${file}`, SIGNED_SECONDS)
  if (error || !data) return new NextResponse('Not found', { status: 404 })

  // The signed link expires; never let a browser reuse this redirect later.
  return NextResponse.redirect(data.signedUrl, { status: 302, headers: NO_CACHE })
}
