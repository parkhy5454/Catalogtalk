'use client'
import { useEffect, useState } from 'react'

// Shown until the user installs the app or closes the banner.
// Android: one-tap install through the browser's prompt. iPhone: Safari has no prompt API,
// so we show the two-step "Add to Home Screen" guide instead.
const DISMISS_KEY = 'ct-install-dismissed'

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

export default function InstallBanner() {
  const [deferred, setDeferred] = useState<InstallPromptEvent | null>(null)
  const [iosGuide, setIosGuide] = useState(false)
  const [hidden, setHidden] = useState(true)

  useEffect(() => {
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true
    if (standalone || readDismissed()) return

    if (/iphone|ipad|ipod/i.test(navigator.userAgent)) {
      setIosGuide(true)
      setHidden(false)
    }
    const onPrompt = (e: Event) => {
      e.preventDefault()
      setDeferred(e as InstallPromptEvent)
      setHidden(false)
    }
    const onInstalled = () => setHidden(true)
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  const close = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      // Private mode: the banner simply reappears next visit.
    }
    setHidden(true)
  }

  const install = async () => {
    if (!deferred) return
    await deferred.prompt()
    const choice = await deferred.userChoice
    setDeferred(null)
    if (choice.outcome === 'accepted') setHidden(true)
  }

  if (hidden || (!deferred && !iosGuide)) return null

  return (
    <div className="install-banner" role="region" aria-label="앱으로 설치">
      <div className="install-text">
        {deferred ? (
          <>홈 화면에 설치하면 앱처럼 바로 열 수 있어요</>
        ) : (
          <>홈 화면에 추가하면 앱처럼 바로 열 수 있어요. Safari 하단의 <strong>공유(↑)</strong> → <strong>홈 화면에 추가</strong>를 눌러 주세요.</>
        )}
      </div>
      {deferred && (
        <button type="button" className="btn btn-primary" onClick={install}>설치</button>
      )}
      <button type="button" className="install-close" onClick={close} aria-label="닫기">×</button>
    </div>
  )
}
