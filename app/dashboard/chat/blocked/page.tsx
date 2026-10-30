'use client'
// Members I have blocked. Unblocking brings back the chance to message and add them again.
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'

type Blocked = { user_id: string; display_name: string | null }

export default function BlockedPage() {
  const supabase = createClient()
  const [rows, setRows] = useState<Blocked[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data, error: loadErr } = await supabase.rpc('list_blocked_users')
    if (loadErr) setError('목록을 불러오지 못했어요')
    else setRows((data as Blocked[]) ?? [])
  }, [supabase])

  useEffect(() => {
    void load()
  }, [load])

  const unblock = async (userId: string) => {
    const { error: unErr } = await supabase.rpc('unblock_user', { p_user: userId })
    if (unErr) return setError('차단을 해제하지 못했어요')
    await load()
  }

  return (
    <main className="container section">
      <section className="panel">
        <div className="panel-head">
          <h1 className="panel-title">차단한 회원</h1>
          <Link href="/dashboard/chat" className="btn btn-ghost">← 대화</Link>
        </div>

        {error && <div className="notice notice-error" role="alert" style={{ marginTop: 12 }}>{error}</div>}

        {rows === null ? (
          <div className="skeleton" style={{ height: 120, marginTop: 12 }} aria-hidden="true" />
        ) : rows.length === 0 ? (
          <div className="notice notice-info" style={{ marginTop: 12 }}>차단한 회원이 없어요.</div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0', display: 'grid', gap: 8 }}>
            {rows.map((r) => (
              <li key={r.user_id} className="info-box" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span className="truncate">{r.display_name || '회원'}</span>
                <button type="button" className="btn btn-ghost" onClick={() => unblock(r.user_id)}>차단 해제</button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
