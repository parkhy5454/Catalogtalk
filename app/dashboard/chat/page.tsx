'use client'
// Chat: list of conversations.
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'

type Thread = {
  thread_id: string
  partner_id: string
  partner_company: string | null
  last_message_at: string
  last_body: string | null
  unread: number
}

function when(iso: string) {
  return new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export default function ChatListPage() {
  const supabase = createClient()
  const [loaded, setLoaded] = useState(false)
  const [threads, setThreads] = useState<Thread[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('list_chat_threads')
    if (error) setError('대화 목록을 불러오지 못했어요')
    else setThreads((data as Thread[]) ?? [])
  }, [supabase])

  useEffect(() => {
    ;(async () => {
      await load()
      setLoaded(true)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <main className="container section">
      <section className="panel">
        <div className="panel-head">
          <h1 className="panel-title">대화</h1>
          <Link href="/dashboard/chat/new" className="btn btn-primary">새 대화</Link>
        </div>

        {!loaded ? (
          <div className="skeleton" style={{ height: 160 }} aria-hidden="true" />
        ) : error ? (
          <div className="notice notice-error" style={{ marginTop: 12 }}>{error}</div>
        ) : threads.length === 0 ? (
          <div className="notice notice-info" style={{ marginTop: 12 }}>
            아직 대화가 없어요. 상대의 친구 코드를 입력해 대화를 시작해 보세요.
          </div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0', display: 'grid', gap: 8 }}>
            {threads.map((t) => (
              <li key={t.thread_id}>
                <Link href={`/dashboard/chat/${t.thread_id}`} className="info-box" style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <strong className="truncate">{t.partner_company || '회원'}</strong>
                    <span style={{ fontSize: 12, color: 'var(--muted)', flexShrink: 0 }}>{when(t.last_message_at)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 4 }}>
                    <span className="truncate" style={{ fontSize: 13, color: 'var(--muted)' }}>{t.last_body ?? ''}</span>
                    {t.unread > 0 && <span className="pill">{t.unread}</span>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
