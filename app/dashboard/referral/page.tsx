'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { copyText } from '@/lib/clipboard'

export default function ReferralPage() {
  const supabase = createClient()
  const [origin, setOrigin] = useState('')
  const [code, setCode] = useState('')
  const [bonus, setBonus] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)

  useEffect(() => {
    setOrigin(window.location.origin)
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const { data } = await supabase
        .from('customers')
        .select('referral_code, bonus_flipbooks')
        .eq('user_id', user.id)
        .maybeSingle()
      setCode(data?.referral_code ?? '')
      setBonus(data?.bonus_flipbooks ?? 0)
      setLoaded(true)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const link = code && origin ? `${origin}/signup?ref=${code}` : ''

  const handleCopy = async () => {
    if (!link) return
    const ok = await copyText(link)
    setMessage(ok ? { kind: 'success', text: '✅ 추천 링크를 복사했어요' } : { kind: 'error', text: '복사하지 못했어요. 링크를 길게 눌러 직접 복사해 주세요.' })
  }

  return (
    <main className="container section">
      <section className="panel" aria-labelledby="referral-title">
        <div className="panel-head">
          <h1 className="panel-title" id="referral-title">친구 추천</h1>
        </div>

        <div className="stats" aria-label="추천 요약">
          <div className="stat stat-dark">
            <div className="stat-label">추천으로 받은 보너스</div>
            <div className="stat-value">{bonus}개</div>
          </div>
        </div>

        <p style={{ fontSize: 14, color: '#555', margin: '16px 0' }}>
          친구가 아래 링크로 가입하면 나와 친구 모두 플립북을 1개씩 더 만들 수 있어요.
        </p>

        {link ? (
          <div className="fb-actions-row">
            <span className="input truncate" style={{ flex: 1, minWidth: 0 }}>{link}</span>
            <button type="button" className="btn btn-primary" onClick={handleCopy}>
              링크 복사
            </button>
          </div>
        ) : (
          <div className="notice notice-info">
            {loaded ? '추천 링크를 준비하지 못했어요. 잠시 후 새로고침해 주세요.' : '추천 링크를 불러오고 있어요...'}
          </div>
        )}

        {message && (
          <div className={`notice ${message.kind === 'error' ? 'notice-error' : 'notice-success'}`} role="status" style={{ marginTop: 16 }}>
            {message.text}
          </div>
        )}
      </section>
    </main>
  )
}
