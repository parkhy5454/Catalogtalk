import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: '카탈로그톡 - PDF를 카톡에서 바로 보는 플립북 링크',
  description: 'PDF 카탈로그를 카톡에서 바로 보는 플립북 링크로 변환. 조회수 추적, 카톡 공유 최적화. Vercel + Supabase로 월 0원 운영.',
  keywords: ['플립북', '카탈로그', 'PDF', '카카오톡', 'CatalogTalk'],
  openGraph: {
    title: '카탈로그톡',
    description: 'PDF를 카톡에서 바로 보는 플립북 링크',
    type: 'website',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  )
}