'use client'
// Shown instead of the viewer when a catalog has a password.
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function FlipbookPasswordGate({ slug, title }: { slug: string; title: string }) {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!password || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/flipbook/${encodeURIComponent(slug)}/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? '비밀번호가 맞지 않아요')
        setBusy(false)
        return
      }
      router.refresh()
    } catch {
      setError('인터넷 연결을 확인해 주세요')
      setBusy(false)
    }
  }

  return (
    <main style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <form onSubmit={submit} className="panel" style={{ width: '100%', maxWidth: 360 }}>
        <h1 className="panel-title" style={{ fontSize: 18, wordBreak: 'keep-all' }}>{title}</h1>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6 }}>이 카탈로그는 비밀번호가 필요해요.</p>
        <label className="field" style={{ marginTop: 14 }}>
          <span className="field-label">비밀번호</span>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={busy}
          />
        </label>
        {error && <div className="notice notice-error" role="alert" style={{ marginTop: 12 }}>{error}</div>}
        <button type="submit" className="btn btn-primary btn-block" style={{ marginTop: 14 }} disabled={!password || busy}>
          {busy ? '확인 중...' : '열기'}
        </button>
      </form>
    </main>
  )
}
