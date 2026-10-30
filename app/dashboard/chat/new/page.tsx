'use client'
// Find members by name or company and add them as friends. Adding opens the conversation at once.
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

type Friend = { user_id: string; display_name: string | null }

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
  const [friends, setFriends] = useState<Friend[] | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [groupTitle, setGroupTitle] = useState('')

  useEffect(() => {
    ;(async () => {
      const { data, error } = await supabase.rpc('list_my_friends')
      setFriends(error ? [] : ((data as Friend[]) ?? []))
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const togglePick = (id: string) => {
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const createGroup = async () => {
    if (picked.length < 1) {
      setMessage({ kind: 'error', text: '대화할 친구를 한 명 이상 골라 주세요' })
      return
    }
    setBusy(true)
    setMessage(null)
    const { data: threadId, error } = await supabase.rpc('create_group_chat', {
      p_title: groupTitle.trim(),
      p_members: picked,
    })
    setBusy(false)
    if (error || !threadId) {
      setMessage({ kind: 'error', text: error?.message ?? '단체 대화를 만들지 못했어요' })
      return
    }
    router.push(`/dashboard/chat/${threadId}`)
  }

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

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h2 className="panel-title" style={{ fontSize: 17 }}>단체 대화 만들기</h2>
        </div>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
          친구를 여러 명 골라 함께 대화할 수 있어요. 나중에 친구를 더 초대할 수 있어요.
        </p>

        {friends === null ? (
          <div className="skeleton" style={{ height: 80, marginTop: 12 }} aria-hidden="true" />
        ) : friends.length === 0 ? (
          <div className="notice notice-info" style={{ marginTop: 12 }}>
            아직 친구가 없어요. 위에서 친구를 찾아 추가해 보세요.
          </div>
        ) : (
          <>
            <input
              className="input"
              value={groupTitle}
              onChange={(e) => setGroupTitle(e.target.value)}
              placeholder="대화방 이름 (비워 두면 참여자 이름)"
              maxLength={40}
              style={{ marginTop: 12, width: '100%' }}
              disabled={busy}
            />
            <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0', display: 'grid', gap: 6 }}>
              {friends.map((f) => {
                const on = picked.includes(f.user_id)
                return (
                  <li key={f.user_id}>
                    <label className="info-box" style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                      <input type="checkbox" checked={on} onChange={() => togglePick(f.user_id)} disabled={busy} />
                      <span className="truncate">{f.display_name || '회원'}</span>
                    </label>
                  </li>
                )
              })}
            </ul>
            <button
              type="button"
              className="btn btn-primary btn-block"
              style={{ marginTop: 12 }}
              onClick={createGroup}
              disabled={busy || picked.length === 0}
            >
              {picked.length > 0 ? `${picked.length}명과 단체 대화 시작` : '친구를 골라 주세요'}
            </button>
          </>
        )}
      </section>
    </main>
  )
}
