import type { Metadata, Viewport } from 'next'
import './globals.css'
import { SITE_NAME, SITE_URL } from '@/lib/site'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: '카탈로그톡 - PDF를 카톡에서 바로 보는 플립북 링크',
    template: '%s | 카탈로그톡',
  },
  description:
    'PDF 카탈로그를 카톡에서 바로 보는 플립북 링크로 변환. 앱 설치 없이 열람, 조회수 추적. 모바일 최적화.',
  keywords: ['플립북', '카탈로그', 'PDF', '카카오톡', 'CatalogTalk'],
  applicationName: SITE_NAME,
  openGraph: {
    siteName: SITE_NAME,
    title: '카탈로그톡',
    description: 'PDF를 카톡에서 바로 보는 플립북 링크',
    type: 'website',
    url: SITE_URL,
  },
  // Keep crawlers and in-app browsers from caching an out-of-date viewer page.
  robots: { index: true, follow: true },
}

// Mobile viewport. `interactive-widget=resizes-content` makes the layout viewport
// shrink when the on-screen keyboard opens, so inputs stay visible.
// Pinch-zoom stays allowed (userScalable) for accessibility.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
  themeColor: '#fee500',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <head>
        {/* Font preloading: Noto Sans KR (Korean glyphs split by unicode-range, loaded on demand). */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="preload"
          as="style"
          href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700;900&display=swap"
        />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700;900&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  )
}
