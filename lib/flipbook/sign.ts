// Server-side: turn stored references into URLs a viewer can load.
import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { PRIVATE_BUCKET, SIGNED_PAGE_SECONDS, isPrivateRef, privatePathOf } from '@/lib/flipbook/storage'

/** Map stored page references to browser URLs. Private ones get signed URLs in one request. */
export async function resolvePageUrls(refs: string[]): Promise<string[]> {
  const privateIdx = refs.map((r, i) => (isPrivateRef(r) ? i : -1)).filter((i) => i >= 0)
  const out = [...refs]
  if (privateIdx.length === 0) return out
  const paths = privateIdx.map((i) => privatePathOf(refs[i]))
  const { data, error } = await createServiceClient()
    .storage.from(PRIVATE_BUCKET)
    .createSignedUrls(paths, SIGNED_PAGE_SECONDS)
  if (error || !data) throw new Error(`페이지 주소 발급 실패: ${error?.message ?? ''}`)
  data.forEach((d, k) => {
    if (d.signedUrl) out[privateIdx[k]] = d.signedUrl
  })
  return out
}
