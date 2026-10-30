// Server component: builds OpenGraph tags on the server so KakaoTalk / Facebook /
// Slack crawlers (which do not run JavaScript) can read title, description and image.
import type { Metadata } from 'next'
import { createAnonClient } from '@/lib/supabase/anon'
import { SITE_NAME, SITE_URL } from '@/lib/site'
import type { FlipbookPublic, PageImage } from '@/lib/flipbook/types'
import { resolvePageUrls } from '@/lib/flipbook/sign'
import Viewer from './viewer'

export const revalidate = 60

type Props = { params: { slug: string } }

function decodeSlug(raw: string) {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

async function loadFlipbook(slug: string): Promise<FlipbookPublic | null> {
  const { data, error } = await createAnonClient().rpc('get_flipbook', { p_slug: slug })
  if (error || !Array.isArray(data) || data.length === 0) return null
  return data[0] as FlipbookPublic
}

async function loadPages(flipbookId: string): Promise<PageImage[]> {
  const { data, error } = await createAnonClient()
    .from('flipbook_pages')
    .select('page_no, image_url')
    .eq('flipbook_id', flipbookId)
    .order('page_no', { ascending: true })
  if (error || !data) return []
  const rows = data as PageImage[]
  // Private pages get short-lived signed URLs; legacy public URLs pass through unchanged.
  const urls = await resolvePageUrls(rows.map((r) => r.image_url))
  return rows.map((r, i) => ({ page_no: r.page_no, image_url: urls[i] }))
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const slug = decodeSlug(params.slug)
  const fb = await loadFlipbook(slug)
  if (!fb) {
    return { title: '플립북을 찾을 수 없어요', robots: { index: false, follow: false } }
  }

  const url = `${SITE_URL}/b/${fb.slug}`
  const description = fb.page_count
    ? `${fb.page_count}쪽 카탈로그 · 카톡에서 바로 넘겨 보세요`
    : '카톡에서 바로 넘겨 보는 카탈로그'
  const image = fb.thumb_url

  return {
    title: fb.title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title: fb.title,
      description,
      url,
      siteName: SITE_NAME,
      type: 'website',
      locale: 'ko_KR',
      images: image ? [{ url: image, alt: fb.title }] : undefined,
    },
    twitter: {
      card: image ? 'summary_large_image' : 'summary',
      title: fb.title,
      description,
      images: image ? [image] : undefined,
    },
  }
}

export default async function ViewerPage({ params }: Props) {
  const slug = decodeSlug(params.slug)
  const fb = await loadFlipbook(slug)
  if (!fb) {
    return (
      <div className="viewer">
        <div className="viewer-empty" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
          <div>플립북을 찾을 수 없어요</div>
          <a href="/" className="btn btn-white">홈으로</a>
        </div>
      </div>
    )
  }

  const pages = await loadPages(fb.id)
  return <Viewer flipbook={fb} pages={pages} />
}
