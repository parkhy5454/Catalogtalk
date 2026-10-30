// Original file download for a public catalog. Checks the link is still on (get_flipbook filters
// is_public), then redirects to a short-lived signed URL. The redirect is never cached, so an
// old address cannot keep working after the link is turned off.
import { NextResponse } from 'next/server'
import { createAnonClient } from '@/lib/supabase/anon'
import { createServiceClient } from '@/lib/supabase/service'
import { PRIVATE_BUCKET, SIGNED_ORIGINAL_SECONDS, isPrivateRef, privatePathOf } from '@/lib/flipbook/storage'

export const dynamic = 'force-dynamic'

const noStore = { 'Cache-Control': 'no-store' }

function decodeSlug(raw: string) {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const slug = decodeSlug(params.slug)
  const { data, error } = await createAnonClient().rpc('get_flipbook', { p_slug: slug })
  const row = Array.isArray(data) ? data[0] : null
  if (error || !row?.pdf_url) return new NextResponse('Not found', { status: 404, headers: noStore })

  let target = row.pdf_url as string
  if (isPrivateRef(target)) {
    const { data: signed, error: signErr } = await createServiceClient()
      .storage.from(PRIVATE_BUCKET)
      .createSignedUrl(privatePathOf(target), SIGNED_ORIGINAL_SECONDS)
    if (signErr || !signed) return new NextResponse('Unavailable', { status: 500, headers: noStore })
    target = signed.signedUrl
  }
  return NextResponse.redirect(new URL(target), { status: 302, headers: noStore })
}
