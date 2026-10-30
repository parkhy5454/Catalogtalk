'use client'
// One business conversation: live messages, catalog cards, report and block.
import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

type Msg = {
  id: string
  sender_id: string
  body: string
  catalog_title: string | null
  catalog_slug: string | null
  catalog_thumb: string | null
  created_at: string
  file_path: string | null
  file_name: string | null
  file_type: string | null
  file_size: number | null
}

type Own = { id: string; title: string; slug: string; thumb_url: string | null }
type Member = { user_id: string; display_name: string | null }
type Reader = { user_id: string; last_read_at: string }

function timeOf(iso: string) {
  return new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
}

const MENU_ITEM: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '13px 16px',
  fontSize: 15,
  background: '#fff',
  border: 0,
  borderBottom: '1px solid #f1f1f1',
  cursor: 'pointer',
  color: '#111',
}

function dayKey(iso: string) {
  return new Date(iso).toDateString()
}

function sizeLabel(bytes: number | null) {
  if (!bytes) return ''
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`
}

function dayLabel(iso: string) {
  return new Date(iso).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })
}

export default function ChatThreadPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const supabase = createClient()
  const [me, setMe] = useState<string | null>(null)
  const [partner, setPartner] = useState<{ id: string; company: string | null } | null>(null)
  const [pinned, setPinned] = useState(false)
  const [messages, setMessages] = useState<Msg[]>([])
  const [loaded, setLoaded] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [catalogs, setCatalogs] = useState<Own[] | null>(null)
  const [isGroup, setIsGroup] = useState(false)
  const [members, setMembers] = useState<Member[]>([])
  const [friends, setFriends] = useState<Member[] | null>(null)
  const [invitePicked, setInvitePicked] = useState<string[]>([])
  const [inviteOpen, setInviteOpen] = useState(false)
  const [readers, setReaders] = useState<Reader[]>([])
  const [savingId, setSavingId] = useState<string | null>(null)
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set())
  const [menuOpen, setMenuOpen] = useState(false)
  const [receipts, setReceipts] = useState(true)
  const bottom = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const loadMembers = useCallback(async () => {
    const { data } = await supabase.rpc('get_chat_members', { p_thread: id })
    setMembers((data as Member[]) ?? [])
  }, [id, supabase])

  const loadReaders = useCallback(async () => {
    const { data } = await supabase.rpc('get_read_status', { p_thread: id })
    setReaders((data as Reader[]) ?? [])
  }, [id, supabase])

  // Count of other members who had read the room at or after this message was sent.
  const readCountOf = (m: Msg) =>
    readers.filter((r) => new Date(r.last_read_at).getTime() >= new Date(m.created_at).getTime()).length

  const nameOf = (uid: string) => members.find((m) => m.user_id === uid)?.display_name || '회원'

  const markRead = useCallback(async (uid: string) => {
    await supabase
      .from('chat_reads')
      .upsert({ thread_id: id, user_id: uid, last_read_at: new Date().toISOString() }, { onConflict: 'thread_id,user_id' })
  }, [id, supabase])

  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return setLoaded(true)
      setMe(user.id)

      const { data: info } = await supabase.rpc('get_chat_thread', { p_id: id })
      const thread = Array.isArray(info) ? info[0] : null
      if (!thread) {
        setLoaded(true)
        return
      }
      setPartner({ id: thread.partner_id ?? '', company: thread.alias || thread.partner_company })
      setPinned(thread.pinned === true)
      setIsGroup(thread.is_group === true)
      if (thread.is_group === true) await loadMembers()
      const { data: receiptOn } = await supabase.rpc('get_my_read_receipts')
      setReceipts(receiptOn !== false)

      const { data: rows, error: msgErr } = await supabase
        .from('chat_messages')
        .select('id, sender_id, body, catalog_title, catalog_slug, catalog_thumb, created_at, file_path, file_name, file_type, file_size')
        .eq('thread_id', id)
        .order('created_at', { ascending: true })
        .limit(300)
      if (msgErr) setError('대화를 불러오지 못했어요')
      setMessages((rows as Msg[]) ?? [])
      setLoaded(true)
      await markRead(user.id)
      await loadReaders()

      channel = supabase
        .channel(`chat-${id}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `thread_id=eq.${id}` },
          (payload) => {
            const row = payload.new as Msg
            setMessages((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, row]))
            if (row.sender_id !== user.id) void markRead(user.id)
          }
        )
        .subscribe()
    })()
    return () => {
      if (channel) supabase.removeChannel(channel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length])

  // Read status has no realtime feed (chat_reads is private per user), so refresh it on a short interval.
  useEffect(() => {
    if (!me || !receipts) return
    const timer = setInterval(() => void loadReaders(), 15000)
    return () => clearInterval(timer)
  }, [me, receipts, loadReaders])

  const send = async (payload: { body: string; catalog?: Own }) => {
    if (!me || busy) return
    setBusy(true)
    setError(null)
    const { data, error: sendErr } = await supabase
      .from('chat_messages')
      .insert({
        thread_id: id,
        sender_id: me,
        body: payload.body,
        catalog_title: payload.catalog?.title ?? null,
        catalog_slug: payload.catalog?.slug ?? null,
        catalog_thumb: payload.catalog?.thumb_url ?? null,
      })
      .select('id, sender_id, body, catalog_title, catalog_slug, catalog_thumb, created_at, file_path, file_name, file_type, file_size')
      .single()
    setBusy(false)
    if (sendErr || !data) {
      setError('메시지를 보내지 못했어요. 상대가 대화를 막았을 수 있어요.')
      return
    }
    const row = data as Msg
    setMessages((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, row]))
    void loadReaders()
  }

  const submitText = async (e: React.FormEvent) => {
    e.preventDefault()
    const body = text.trim()
    if (!body) return
    await send({ body: body.slice(0, 2000) })
    setText('')
  }

  const openCatalogPicker = async () => {
    if (!me) return
    if (catalogs) return setCatalogs(null)
    const { data } = await supabase
      .from('flipbooks')
      .select('id, title, slug, thumb_url')
      .eq('user_id', me)
      .order('created_at', { ascending: false })
    setCatalogs((data as Own[]) ?? [])
  }

  const sendFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0]
    e.target.value = ''
    if (!picked || !me) return
    setBusy(true)
    setError(null)
    const fd = new FormData()
    fd.append('file', picked)
    fd.append('thread_id', id)
    const res = await fetch('/api/chat/upload', { method: 'POST', body: fd })
    setBusy(false)
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: Msg }
    if (!res.ok || !body.message) {
      setError(body.error ?? '파일을 보내지 못했어요')
      return
    }
    const row = body.message
    setMessages((prev) => (prev.some((x) => x.id === row.id) ? prev : [...prev, row]))
    void loadReaders()
  }

  const saveCatalog = async (m: Msg) => {
    setSavingId(m.id)
    setError(null)
    const res = await fetch('/api/chat/save-catalog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_id: m.id }),
    })
    setSavingId(null)
    const body = (await res.json().catch(() => ({}))) as { error?: string; ok?: boolean }
    if (!res.ok || !body.ok) {
      setError(body.error ?? '저장하지 못했어요')
      return
    }
    setSavedIds((prev) => new Set(prev).add(m.id))
  }

  const report = async (m: Msg) => {
    if (!me) return
    const reason = window.prompt('신고 사유를 적어 주세요 (500자 이내)')
    if (reason === null) return
    if (!reason.trim()) {
      setError('신고 사유를 적어 주세요')
      return
    }
    const { error: repErr } = await supabase
      .from('chat_reports')
      .insert({ reporter_id: me, message_id: m.id, reason: reason.trim().slice(0, 500) })
    setError(repErr ? '신고하지 못했어요' : null)
    if (!repErr) window.alert('신고가 접수됐어요. 운영팀이 확인할게요.')
  }

  const rename = async () => {
    const input = window.prompt('이 대화방에서만 보일 이름을 입력해 주세요 (비우면 원래 이름)', partner?.company ?? '')
    if (input === null) return
    const { error: aliasErr } = await supabase.rpc('set_chat_alias', { p_thread: id, p_alias: input })
    if (aliasErr) return setError('이름을 바꾸지 못했어요')
    setPartner((prev) => (prev ? { ...prev, company: input.trim() || prev.company } : prev))
    setError(null)
  }

  const openInvite = async () => {
    if (inviteOpen) {
      setInviteOpen(false)
      return
    }
    const { data, error: friendErr } = await supabase.rpc('list_my_friends')
    if (friendErr) return setError('친구 목록을 불러오지 못했어요')
    const inRoom = new Set(members.map((m) => m.user_id))
    setFriends(((data as Member[]) ?? []).filter((f) => !inRoom.has(f.user_id)))
    setInvitePicked([])
    setInviteOpen(true)
  }

  const invite = async () => {
    if (invitePicked.length === 0) return
    setBusy(true)
    const { error: inviteErr } = await supabase.rpc('add_group_members', { p_thread: id, p_members: invitePicked })
    setBusy(false)
    if (inviteErr) return setError(inviteErr.message || '초대하지 못했어요')
    setInviteOpen(false)
    setError(null)
    await loadMembers()
  }

  const blockPartner = async () => {
    if (!partner?.id) return
    const ok = window.confirm('이 회원을 차단할까요?\n서로 메시지를 보낼 수 없고, 목록에서도 사라져요. 차단 해제는 설정 > 차단한 회원에서 할 수 있어요.')
    if (!ok) return
    const { error: blockErr } = await supabase.rpc('block_user', { p_user: partner.id })
    if (blockErr) return setError('차단하지 못했어요')
    router.push('/dashboard/chat')
  }

  const leave = async () => {
    const ok = isGroup
      ? window.confirm('이 단체 대화방에서 나갈까요?\n나가면 대화 내용이 보이지 않아요. 다른 사람에게는 알리지 않아요.')
      : window.confirm('이 대화방을 목록에서 나갈까요?\n상대방 쪽 대화는 그대로 남아요. 새 메시지가 오면 다시 나타나요.')
    if (!ok) return
    const { error: leaveErr } = await supabase.rpc('leave_chat', { p_thread: id })
    if (leaveErr) return setError('나가지 못했어요')
    router.push('/dashboard/chat')
  }

  const togglePin = async () => {
    if (!me) return
    if (pinned) {
      const { error: pinErr } = await supabase.from('chat_pins').delete().eq('user_id', me).eq('thread_id', id)
      if (pinErr) return setError('고정을 해제하지 못했어요')
    } else {
      const { error: pinErr } = await supabase.from('chat_pins').insert({ user_id: me, thread_id: id })
      if (pinErr) return setError('고정하지 못했어요')
    }
    setPinned(!pinned)
  }

  if (!loaded) {
    return (
      <main className="container section">
        <div className="skeleton" style={{ height: 200 }} aria-hidden="true" />
      </main>
    )
  }

  if (!partner) {
    return (
      <main className="container section">
        <div className="notice notice-error">대화를 찾을 수 없어요.</div>
        <Link href="/dashboard/chat" className="btn btn-ghost btn-block" style={{ marginTop: 12 }}>대화 목록으로</Link>
      </main>
    )
  }

  return (
    <main className="container section" style={{ paddingBottom: 120, background: '#eef0f3', minHeight: '100vh' }}>
      <header
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 5,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          margin: '0 0 8px',
          padding: '8px 4px',
          background: 'rgba(255,255,255,0.94)',
          borderBottom: '1px solid #e5e7eb',
          backdropFilter: 'blur(8px)',
        }}
      >
        <Link href="/dashboard/chat" aria-label="대화 목록" style={{ width: 36, height: 36, display: 'grid', placeItems: 'center', fontSize: 26, lineHeight: 1, color: '#111', textDecoration: 'none' }}>
          ‹
        </Link>
        <div style={{ flex: 1, minWidth: 0, textAlign: 'center' }}>
          <div className="truncate" style={{ fontWeight: 700, fontSize: 16 }}>{partner.company || (isGroup ? '단체 대화' : '회원')}</div>
          {isGroup && <div style={{ fontSize: 11, color: '#8a8a8a' }}>참여자 {members.length}명</div>}
        </div>
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="대화 메뉴"
          aria-expanded={menuOpen}
          style={{ width: 36, height: 36, borderRadius: 18, border: 0, background: 'transparent', fontSize: 20, lineHeight: 1, cursor: 'pointer', color: '#111' }}
        >
          ⋯
        </button>

        {menuOpen && (
          <>
            <div onClick={() => setMenuOpen(false)} aria-hidden="true" style={{ position: 'fixed', inset: 0, zIndex: 9 }} />
            <div role="menu" style={{ position: 'absolute', right: 4, top: 46, zIndex: 10, minWidth: 180, background: '#fff', borderRadius: 14, boxShadow: '0 10px 30px rgba(0,0,0,0.15)', overflow: 'hidden' }}>
              <button type="button" role="menuitem" style={MENU_ITEM} onClick={() => { setMenuOpen(false); void rename() }}>이름 바꾸기</button>
              <button type="button" role="menuitem" style={MENU_ITEM} onClick={() => { setMenuOpen(false); void togglePin() }}>{pinned ? '고정 해제' : '고정하기'}</button>
              {isGroup && (
                <button type="button" role="menuitem" style={MENU_ITEM} onClick={() => { setMenuOpen(false); void openInvite() }}>친구 초대</button>
              )}
              {!isGroup && partner?.id && (
                <button type="button" role="menuitem" style={{ ...MENU_ITEM, color: '#d32f2f' }} onClick={() => { setMenuOpen(false); void blockPartner() }}>차단하기</button>
              )}
              <button type="button" role="menuitem" style={{ ...MENU_ITEM, color: '#d32f2f', borderBottom: 0 }} onClick={() => { setMenuOpen(false); void leave() }}>나가기</button>
            </div>
          </>
        )}
      </header>

      {error && <div className="notice notice-error" role="alert" style={{ marginBottom: 10 }}>{error}</div>}

      {isGroup && inviteOpen && (
        <div className="panel" style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>초대할 친구 고르기</div>
          {friends && friends.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>초대할 친구가 없어요.</div>
          ) : (
            <>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 }}>
                {(friends ?? []).map((f) => (
                  <li key={f.user_id}>
                    <label className="info-box" style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={invitePicked.includes(f.user_id)}
                        onChange={() =>
                          setInvitePicked((prev) =>
                            prev.includes(f.user_id) ? prev.filter((x) => x !== f.user_id) : [...prev, f.user_id]
                          )
                        }
                      />
                      <span className="truncate">{f.display_name || '회원'}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <button type="button" className="btn btn-primary btn-block" style={{ marginTop: 10 }} onClick={invite} disabled={busy || invitePicked.length === 0}>
                {invitePicked.length > 0 ? `${invitePicked.length}명 초대` : '친구를 골라 주세요'}
              </button>
            </>
          )}
        </div>
      )}

      <div style={{ display: 'grid' }}>
        {messages.length === 0 && (
          <div className="notice notice-info" style={{ marginTop: 8 }}>첫 메시지를 보내 보세요. 카탈로그를 첨부하면 바로 열어 볼 수 있어요.</div>
        )}
        {messages.map((m, i) => {
          const prev = messages[i - 1]
          const next = messages[i + 1]
          const mine = m.sender_id === me
          const newDay = !prev || dayKey(prev.created_at) !== dayKey(m.created_at)
          const firstInGroup = newDay || prev.sender_id !== m.sender_id
          const lastInGroup = !next || next.sender_id !== m.sender_id || dayKey(next.created_at) !== dayKey(m.created_at)
          const readCount = mine && receipts ? readCountOf(m) : 0
          return (
            <Fragment key={m.id}>
              {newDay && (
                <div style={{ textAlign: 'center', fontSize: 12, color: '#8a8a8a', margin: '16px 0 6px' }}>{dayLabel(m.created_at)}</div>
              )}
              <div style={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start', marginTop: firstInGroup ? 10 : 2 }}>
                <div style={{ maxWidth: '78%', display: 'grid', gap: 3, justifyItems: mine ? 'end' : 'start' }}>
                  {isGroup && !mine && firstInGroup && (
                    <span style={{ fontSize: 12, color: '#6b6b6b', padding: '0 6px' }}>{nameOf(m.sender_id)}</span>
                  )}
                  {m.catalog_slug && (
                    <a
                      href={`/b/${m.catalog_slug}`}
                      style={{
                        display: 'flex',
                        gap: 10,
                        alignItems: 'center',
                        textDecoration: 'none',
                        color: 'inherit',
                        padding: 10,
                        background: '#fff',
                        borderRadius: 14,
                        boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
                      }}
                    >
                      {m.catalog_thumb ? (
                        <img src={m.catalog_thumb} alt="" width={44} height={56} style={{ objectFit: 'cover', borderRadius: 4 }} />
                      ) : (
                        <span aria-hidden="true">📄</span>
                      )}
                      <span className="truncate" style={{ fontWeight: 600 }}>{m.catalog_title || '카탈로그'}</span>
                    </a>
                  )}
                  {m.file_path && (
                    m.file_type?.startsWith('image/') ? (
                      <a href={`/api/chat/file?id=${m.id}`} target="_blank" rel="noreferrer" style={{ display: 'block', borderRadius: 14, overflow: 'hidden' }}>
                        <img
                          src={`/api/chat/file?id=${m.id}`}
                          alt={m.file_name ?? '사진'}
                          loading="lazy"
                          style={{ display: 'block', maxWidth: 240, maxHeight: 320, width: 'auto', height: 'auto' }}
                        />
                      </a>
                    ) : (
                      <a
                        href={`/api/chat/file?id=${m.id}`}
                        target="_blank"
                        rel="noreferrer"
                        style={{ display: 'flex', gap: 10, alignItems: 'center', maxWidth: 260, padding: '10px 12px', background: '#fff', borderRadius: 14, boxShadow: '0 1px 2px rgba(0,0,0,0.06)', color: 'inherit', textDecoration: 'none' }}
                      >
                        <span aria-hidden="true" style={{ fontSize: 22 }}>📄</span>
                        <span style={{ minWidth: 0 }}>
                          <span className="truncate" style={{ display: 'block', fontWeight: 600, fontSize: 14 }}>{m.file_name || '파일'}</span>
                          <span style={{ fontSize: 11, color: '#8a8a8a' }}>{sizeLabel(m.file_size)}</span>
                        </span>
                      </a>
                    )
                  )}
                  {m.body && (
                    <div
                      style={{
                        padding: '9px 13px',
                        fontSize: 15,
                        lineHeight: 1.5,
                        borderRadius: mine
                          ? (lastInGroup ? '18px 18px 4px 18px' : 18)
                          : (lastInGroup ? '18px 18px 18px 4px' : 18),
                        background: mine ? 'var(--yellow, #fee500)' : '#fff',
                        color: 'var(--ink, #111)',
                        boxShadow: mine ? 'none' : '0 1px 1px rgba(0,0,0,0.05)',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {m.body}
                    </div>
                  )}
                  {lastInGroup && (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, color: '#8a8a8a', padding: '0 4px' }}>
                      {mine && receipts && (isGroup
                        ? (readCount > 0 && <span style={{ fontWeight: 700, color: '#555' }}>{readCount}명 읽음</span>)
                        : <span style={{ fontWeight: 700, color: '#555' }}>{readCount > 0 ? '읽음' : '1'}</span>)}
                      <span>{timeOf(m.created_at)}</span>
                      {!mine && m.catalog_slug && (
                        savedIds.has(m.id) ? (
                          <Link href="/dashboard/folders" style={{ color: '#111', fontWeight: 700 }}>저장됨</Link>
                        ) : (
                          <button
                            type="button"
                            onClick={() => saveCatalog(m)}
                            disabled={savingId !== null}
                            style={{ color: '#111', fontWeight: 700, background: 'none', border: 0, padding: 0, cursor: 'pointer', fontSize: 11 }}
                          >
                            {savingId === m.id ? '저장 중...' : '내 목록에 저장'}
                          </button>
                        )
                      )}
                      {!mine && (
                        <button type="button" onClick={() => report(m)} style={{ fontSize: 11, color: '#8a8a8a', background: 'none', border: 0, padding: 0, cursor: 'pointer' }}>
                          신고
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </Fragment>
          )
        })}
        <div ref={bottom} />
      </div>

      {catalogs && (
        <div className="panel" style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>보낼 카탈로그 선택</span>
            <button
              type="button"
              onClick={() => setCatalogs(null)}
              aria-label="카탈로그 선택 닫기"
              style={{ background: 'none', border: 0, fontSize: 18, lineHeight: 1, padding: 4, cursor: 'pointer', color: 'var(--muted)' }}
            >
              ✕
            </button>
          </div>
          {catalogs.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>보낼 수 있는 카탈로그가 없어요.</div>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 }}>
              {catalogs.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className="info-box"
                    style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }}
                    onClick={async () => {
                      setCatalogs(null)
                      await send({ body: '', catalog: c })
                    }}
                  >
                    {c.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <form
        onSubmit={submitText}
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          // Sits above the bottom tab bar (64px + iPhone home-indicator inset).
          bottom: 'calc(64px + env(safe-area-inset-bottom, 0px))',
          padding: '8px 10px',
          background: 'rgba(255,255,255,0.96)',
          borderTop: '1px solid #e5e7eb',
          display: 'flex',
          gap: 6,
          alignItems: 'flex-end',
        }}
      >
        <button
          type="button"
          onClick={openCatalogPicker}
          disabled={busy}
          aria-label="카탈로그 첨부"
          style={{ width: 40, height: 40, borderRadius: 20, border: 0, background: 'transparent', fontSize: 20, cursor: 'pointer', flexShrink: 0 }}
        >
          📎
        </button>
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={busy}
          aria-label="사진이나 PDF 보내기"
          style={{ width: 40, height: 40, borderRadius: 20, border: 0, background: 'transparent', fontSize: 20, cursor: 'pointer', flexShrink: 0 }}
        >
          🖼
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/jpeg,image/png,image/webp,application/pdf"
          onChange={sendFile}
          hidden
        />
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // On a computer, Enter sends and Shift+Enter makes a new line. Phones keep Enter as a new line.
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
            if (!window.matchMedia('(pointer: fine)').matches) return
            e.preventDefault()
            if (text.trim() && !busy) e.currentTarget.form?.requestSubmit()
          }}
          maxLength={2000}
          rows={1}
          placeholder="메시지"
          disabled={busy}
          style={{
            flex: 1,
            resize: 'none',
            border: 0,
            outline: 'none',
            background: '#f1f2f4',
            borderRadius: 20,
            padding: '10px 14px',
            fontSize: 15,
            lineHeight: 1.4,
            maxHeight: 120,
            fontFamily: 'inherit',
          }}
        />
        <button
          type="submit"
          disabled={busy || !text.trim()}
          aria-label="보내기"
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            border: 0,
            flexShrink: 0,
            background: text.trim() ? 'var(--yellow, #fee500)' : '#e2e4e8',
            color: '#111',
            fontSize: 18,
            fontWeight: 800,
            cursor: text.trim() ? 'pointer' : 'default',
          }}
        >
          ↑
        </button>
      </form>
    </main>
  )
}
