'use client'
// Team: create one team, invite members by link, share one catalog pool. Members are equal.
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'

type Team = { id: string; name: string; member_count: number; catalog_count: number }
type Member = { user_id: string; display_name: string | null; company_name: string | null; is_me: boolean }
type Catalog = { id: string; title: string; slug: string; views: number }

const TEAM_CATALOG_LIMIT = 200 // keep in sync with enforce_flipbook_limit (v32)

export default function TeamPage() {
  const supabase = createClient()
  const [loaded, setLoaded] = useState(false)
  const [team, setTeam] = useState<Team | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [catalogs, setCatalogs] = useState<Catalog[]>([])
  const [name, setName] = useState('')
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)

  const load = useCallback(async () => {
    const { data } = await supabase.rpc('get_my_team')
    const t = ((data as Team[]) ?? [])[0] ?? null
    setTeam(t)
    if (t) {
      const [mem, cat] = await Promise.all([
        supabase.rpc('list_team_members'),
        supabase.from('flipbooks').select('id, title, slug, views').eq('team_id', t.id).order('created_at', { ascending: false }),
      ])
      setMembers((mem.data as Member[]) ?? [])
      setCatalogs((cat.data as Catalog[]) ?? [])
    } else {
      setMembers([])
      setCatalogs([])
    }
    setLoaded(true)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const createTeam = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setMessage(null)
    const { error } = await supabase.rpc('create_team', { p_name: name })
    setBusy(false)
    if (error) return setMessage({ kind: 'error', text: error.message })
    setName('')
    await load()
  }

  const makeInvite = async () => {
    setBusy(true)
    setMessage(null)
    const { data: token, error } = await supabase.rpc('create_team_invite')
    setBusy(false)
    if (error || !token) return setMessage({ kind: 'error', text: error?.message ?? '초대 링크를 만들지 못했어요' })
    setInviteUrl(`${window.location.origin}/dashboard/team/join/${token}`)
  }

  const copyInvite = async () => {
    if (!inviteUrl) return
    try {
      await navigator.clipboard.writeText(inviteUrl)
      setMessage({ kind: 'success', text: '초대 링크를 복사했어요. 7일 동안 쓸 수 있어요.' })
    } catch {
      setMessage({ kind: 'error', text: '복사하지 못했어요. 링크를 길게 눌러 직접 복사해 주세요.' })
    }
  }

  const leave = async () => {
    if (!window.confirm('팀에서 나갈까요? 내가 만든 자료는 내 자료로 남아요.')) return
    setBusy(true)
    const { error } = await supabase.rpc('leave_team')
    setBusy(false)
    if (error) return setMessage({ kind: 'error', text: error.message })
    setInviteUrl(null)
    await load()
  }

  return (
    <main className="container section">
      <section className="panel">
        <div className="panel-head">
          <h1 className="panel-title">팀</h1>
          <Link href="/dashboard/settings" className="btn btn-ghost">← 설정</Link>
        </div>

        {message && (
          <div className={`notice ${message.kind === 'error' ? 'notice-error' : 'notice-success'}`} role="status" style={{ marginTop: 12 }}>
            {message.text}
          </div>
        )}

        {!loaded ? (
          <div className="skeleton" style={{ height: 120, marginTop: 12 }} aria-hidden="true" />
        ) : !team ? (
          <form onSubmit={createTeam} className="form-stack" style={{ marginTop: 12 }}>
            <p style={{ fontSize: 13, color: 'var(--muted)' }}>
              팀을 만들면 팀원끼리 자료 한도를 함께 쓰고, 팀 자료를 한눈에 볼 수 있어요.
            </p>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="팀 이름 (예: 영업팀)"
              maxLength={40}
              disabled={busy}
            />
            <button type="submit" className="btn btn-primary btn-block" disabled={busy || name.trim().length === 0}>
              팀 만들기
            </button>
          </form>
        ) : (
          <>
            <div className="info-box" style={{ marginTop: 12 }}>
              <div className="info-label">팀 이름</div>
              <div className="info-value">{team.name}</div>
              <div className="info-label" style={{ marginTop: 8 }}>자료</div>
              <div className="info-value">{team.catalog_count} / {TEAM_CATALOG_LIMIT}개 (팀 전체)</div>
            </div>

            <h2 className="panel-title" style={{ fontSize: 16, marginTop: 20 }}>팀원 {members.length}명</h2>
            <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', display: 'grid', gap: 6 }}>
              {members.map((m) => (
                <li key={m.user_id} className="info-box" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 14 }}>
                  <span className="truncate">{m.company_name || m.display_name || '회원'}{m.company_name && m.display_name ? ` · ${m.display_name}` : ''}</span>
                  {m.is_me && <span style={{ color: 'var(--muted)', fontSize: 12 }}>나</span>}
                </li>
              ))}
            </ul>

            <h2 className="panel-title" style={{ fontSize: 16, marginTop: 20 }}>팀원 초대</h2>
            <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
              초대 링크를 보내면 로그인 후 바로 팀에 들어와요. 링크는 7일 동안 유효해요.
            </p>
            {inviteUrl ? (
              <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                <input className="input" value={inviteUrl} readOnly onFocus={(e) => e.currentTarget.select()} />
                <button type="button" className="btn btn-primary btn-block" onClick={copyInvite}>링크 복사</button>
              </div>
            ) : (
              <button type="button" className="btn btn-ghost btn-block" style={{ marginTop: 8 }} onClick={makeInvite} disabled={busy}>
                초대 링크 만들기
              </button>
            )}

            <h2 className="panel-title" style={{ fontSize: 16, marginTop: 20 }}>팀 자료</h2>
            {catalogs.length === 0 ? (
              <div className="notice notice-info" style={{ marginTop: 8 }}>아직 팀 자료가 없어요. 자료를 만들면 여기에 모여요.</div>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', display: 'grid', gap: 6 }}>
                {catalogs.map((c) => (
                  <li key={c.id} className="info-box" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', fontSize: 14 }}>
                    <span className="truncate">{c.title}</span>
                    <span style={{ color: 'var(--muted)', fontSize: 12, whiteSpace: 'nowrap' }}>조회 {c.views.toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            )}

            <button type="button" className="btn btn-danger btn-block" style={{ marginTop: 28 }} onClick={leave} disabled={busy}>
              팀 나가기
            </button>
          </>
        )}
      </section>
    </main>
  )
}
