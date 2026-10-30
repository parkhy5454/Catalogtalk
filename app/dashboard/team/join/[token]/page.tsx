'use client'
// Opened from a team invite link. Joining is a single call; on success the team page opens.
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export default function JoinTeamPage() {
  const { token } = useParams<{ token: string }>()
  const router = useRouter()
  const supabase = createClient()
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    ;(async () => {
      const { error: err } = await supabase.rpc('join_team', { p_token: token })
      if (err) {
        setError(err.message)
        return
      }
      router.replace('/dashboard/team')
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  return (
    <main className="container section">
      <section className="panel">
        {error ? (
          <>
            <div className="notice notice-error" role="alert">{error}</div>
            <Link href="/dashboard/team" className="btn btn-ghost btn-block" style={{ marginTop: 16 }}>팀 화면으로</Link>
          </>
        ) : (
          <div className="notice notice-info" role="status">팀에 들어가는 중이에요...</div>
        )}
      </section>
    </main>
  )
}
