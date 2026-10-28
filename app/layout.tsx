
import './globals.css'
export const metadata = { 
  title: 'FlipBook - 아이폰처럼 넘어가는 카탈로그',
  description: 'PDF를 아이폰 도서처럼 동그랗게 넘어가는 플립북으로',
  viewport: { width: 'device-width', initialScale: 1, maximumScale: 1, userScalable: false },
  themeColor: '#0f0a12',
  manifest: '/manifest.json'
}
export default function RootLayout({children}:{children:React.ReactNode}){
  return (
    <html lang="ko">
      <head>
        <link rel="manifest" href="/manifest.json" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="FlipBook" />
        <meta name="format-detection" content="telephone=no" />
      </head>
      <body style={{margin:0, fontFamily:'-apple-system, Pretendard, Noto Sans KR, sans-serif', WebkitTapHighlightColor:'transparent', overscrollBehavior:'none'}}>{children}</body>
    </html>
  )
}
