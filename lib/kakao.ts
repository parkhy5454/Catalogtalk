'use client'
// KakaoTalk sharing with the Kakao JavaScript SDK. Only active when NEXT_PUBLIC_KAKAO_JS_KEY is set
// (the JavaScript key of the Kakao Developers app; the site domain must be registered there).

const SDK_URL = 'https://t1.kakaocdn.net/kakao_js_sdk/2.7.4/kakao.min.js'

export const KAKAO_JS_KEY = process.env.NEXT_PUBLIC_KAKAO_JS_KEY ?? ''

type KakaoSdk = {
  isInitialized: () => boolean
  init: (key: string) => void
  Share: { sendDefault: (settings: unknown) => void }
}

declare global {
  interface Window {
    Kakao?: KakaoSdk
  }
}

let loading: Promise<KakaoSdk> | null = null

function loadSdk(): Promise<KakaoSdk> {
  if (loading) return loading
  loading = new Promise<KakaoSdk>((resolve, reject) => {
    const ready = () => {
      if (!window.Kakao) return reject(new Error('카카오 공유를 불러오지 못했어요'))
      if (!window.Kakao.isInitialized()) window.Kakao.init(KAKAO_JS_KEY)
      resolve(window.Kakao)
    }
    if (window.Kakao) return ready()
    const script = document.createElement('script')
    script.src = SDK_URL
    script.async = true
    script.onload = ready
    script.onerror = () => {
      loading = null
      reject(new Error('카카오 공유를 불러오지 못했어요'))
    }
    document.head.appendChild(script)
  })
  return loading
}

/** Send a catalog card to a KakaoTalk chat. Opens the Kakao share picker. */
export async function shareCatalogToKakao(opts: { title: string; imageUrl: string; link: string }) {
  const kakao = await loadSdk()
  kakao.Share.sendDefault({
    objectType: 'feed',
    content: {
      title: opts.title,
      description: '카탈로그톡 플립북으로 보기',
      imageUrl: opts.imageUrl,
      link: { webUrl: opts.link, mobileWebUrl: opts.link },
    },
    buttons: [
      { title: '카탈로그 보기', link: { webUrl: opts.link, mobileWebUrl: opts.link } },
    ],
  })
}
