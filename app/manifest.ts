import type { MetadataRoute } from 'next'
import { SITE_NAME } from '@/lib/site'

// Web app manifest (served at /manifest.webmanifest, linked automatically as <link rel="manifest">).
// Installed on the home screen it opens full screen, like a native app.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: SITE_NAME,
    short_name: SITE_NAME,
    description: 'PDF와 Word 카탈로그를 카톡에서 바로 보는 플립북 링크',
    start_url: '/dashboard',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#000000',
    theme_color: '#FEE500',
    lang: 'ko',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
