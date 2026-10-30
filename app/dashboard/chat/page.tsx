'use client'
// Chat: list of conversations.
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'

type Request = {
  request_id: string
  direction: 'received' | 'sent'
  other_id: string
  display_name: string | null
  created_at: string
}

type Thread = {
  thread_id: string
  partner_id: string
  partner_company: string | null
  last_message_at: string
  last_body: string | null
  unread: number
  pinned: boolean
}

function when(iso: string) {
  return new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export default function ChatListPage() {
  const supabase = createClient()
  const [loaded, setLoaded] = useState(false)
  const [threads, setThreads] = useState<Thread[]>([])
  const [requests, setRequests] = useState<Request[]>([])
  const [error, setError] = useState<string | null>(null)

  const togglePin = async (t: Thread) => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    if (t.pinned) {
      await supabase.from('chat_pins').delete().eq('user_id', user.id).eq('thread_id', t.thread_id)
    } else {
      await supabase.from('chat_pins').insert({ user_id: user.id, thread_id: t.thread_id })
    }
    await load()
  }

  const load = useCallback(async () => {
    const [list, reqs] = await Promise.all([
      supabase.rpc('list_chat_threads'),
      supabase.rpc('list_friend_requests'),
    ])
    if (list.error) setError('대화 목록을 불러오지 못했어요')
    else setThreads((list.data as Thread[]) ?? [])
    setRequests((reqs.data as Request[]) ?? [])
  }, [supabase])

  const respond = async (r: Request, accept: boolean) => {
    const { error: err } = await supabase.rpc('respond_friend_request', { p_id: r.request_id, p_accept: accept })
    if (err) setError(err.message)
    await load()
  }

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
          <Link href="/dashboard/chat/new" className="btn btn-primary">친구 찾기</Link>
        </div>

        {!loaded ? (
          <div className="skeleton" style={{ height: 160 }} aria-hidden="true" />
        ) : (
          <>
            {requests.filter((r) => r.direction === 'received').length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>받은 친구 신청</div>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 }}>
                  {requests.filter((r) => r.direction === 'received').map((r) => (
                    <li key={r.request_id} className="info-box" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <span className="truncate">{r.display_name || '회원'}</span>
                      <span style={{ display: 'flex', gap: 6 }}>
                        <button type="button" className="btn btn-primary" onClick={() => respond(r, true)}>수락</button>
                        <button type="button" className="btn btn-ghost" onClick={() => respond(r, false)}>거절</button>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {requests.filter((r) => r.direction === 'sent').length > 0 && (
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
                보낸 신청 {requests.filter((r) => r.direction === 'sent').length}건이 답을 기다리고 있어요.
              </div>
            )}
          </>
        )}

        {!loaded ? null : error ? (
          <div className="notice notice-error" style={{ marginTop: 12 }}>{error}</div>
        ) : threads.length === 0 ? (
          <div className="notice notice-info" style={{ marginTop: 12 }}>
            아직 대화가 없어요. 상대의 친구 코드를 입력해 대화를 시작해 보세요.
          </div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0', display: 'grid', gap: 8 }}>
            {threads.map((t) => (
              <li key={t.thread_id} style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
                <Link href={`/dashboard/chat/${t.thread_id}`} className="info-box" style={{ flex: 1, minWidth: 0, display: 'block', textDecoration: 'none', color: 'inherit' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <strong className="truncate">{t.pinned ? '📌 ' : ''}{t.partner_company || '회원'}</strong>
                    <span style={{ fontSize: 12, color: 'var(--muted)', flexShrink: 0 }}>{when(t.last_message_at)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 4 }}>
                    <span className="truncate" style={{ fontSize: 13, color: 'var(--muted)' }}>{t.last_body ?? ''}</span>
                    {t.unread > 0 && <span className="pill">{t.unread}</span>}
                  </div>
                </Link>
                <button type="button" className="btn btn-ghost" onClick={() => togglePin(t)} aria-pressed={t.pinned} style={{ flexShrink: 0 }}>
                  {t.pinned ? '고정 해제' : '고정'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
