'use client'
// Find members by name or company and add them as friends. Adding opens the conversation at once.
import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

type Result = {
  user_id: string
  display_name: string | null
  company_name: string | null
  relation: 'none' | 'sent' | 'received' | 'friend' | 'rejected'
  thread_id: string | null
}

export default function FindFriendsPage() {
  const router = useRouter()
  const supabase = createClient()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Result[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)

  const search = async (e: React.FormEvent) => {
    e.preventDefault()
    const q = query.trim()
    if (q.length < 2) {
      setMessage({ kind: 'error', text: '이름이나 회사명을 2글자 이상 입력해 주세요' })
      return
    }
    setBusy(true)
    setMessage(null)
    const { data, error } = await supabase.rpc('search_members', { p_query: q })
    setBusy(false)
    if (error) {
      setMessage({ kind: 'error', text: `검색하지 못했어요: ${error.message}` })
      return
    }
    setResults((data as Result[]) ?? [])
  }

  const addFriend = async (r: Result) => {
    setBusy(true)
    setMessage(null)
    const { data: threadId, error } = await supabase.rpc('send_friend_request', { p_to: r.user_id })
    setBusy(false)
    if (error || !threadId) {
      setMessage({ kind: 'error', text: error?.message ?? '친구를 추가하지 못했어요' })
      return
    }
    router.push(`/dashboard/chat/${threadId}`)
  }

  return (
    <main className="container section">
      <section className="panel">
        <div className="panel-head">
          <h1 className="panel-title">친구 찾기</h1>
          <Link href="/dashboard/chat" className="btn btn-ghost">← 대화</Link>
        </div>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
          회사명이나 이름으로 찾아 친구로 추가하면 바로 대화할 수 있어요.
        </p>

        <form onSubmit={search} style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <input
            className="input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="회사명 또는 이름 (2글자 이상)"
            disabled={busy}
            style={{ flex: 1 }}
          />
          <button type="submit" className="btn btn-primary" disabled={busy}>검색</button>
        </form>

        {message && (
          <div className={`notice ${message.kind === 'error' ? 'notice-error' : 'notice-success'}`} role="status" style={{ marginTop: 12 }}>
            {message.text}
          </div>
        )}

        {results && (
          <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0', display: 'grid', gap: 8 }}>
            {results.length === 0 && (
              <li className="notice notice-info">검색 결과가 없어요.</li>
            )}
            {results.map((r) => (
              <li key={r.user_id} className="info-box" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <strong className="truncate" style={{ display: 'block' }}>{r.company_name || r.display_name || '회원'}</strong>
                  {r.company_name && r.display_name && (
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>{r.display_name}</span>
                  )}
                </div>
                {r.relation === 'friend' && r.thread_id ? (
                  <Link href={`/dashboard/chat/${r.thread_id}`} className="btn btn-primary">대화하기</Link>
                ) : (
                  <button type="button" className="btn btn-primary" onClick={() => addFriend(r)} disabled={busy}>친구 추가</button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
