'use client'
// One business conversation: live messages, catalog cards, report and block.
import { useCallback, useEffect, useRef, useState } from 'react'
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
}

type Own = { id: string; title: string; slug: string; thumb_url: string | null }

function timeOf(iso: string) {
  return new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
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
  const bottom = useRef<HTMLDivElement>(null)

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
      setPartner({ id: thread.partner_id, company: thread.alias || thread.partner_company })
      setPinned(thread.pinned === true)

      const { data: rows, error: msgErr } = await supabase
        .from('chat_messages')
        .select('id, sender_id, body, catalog_title, catalog_slug, catalog_thumb, created_at')
        .eq('thread_id', id)
        .order('created_at', { ascending: true })
        .limit(300)
      if (msgErr) setError('대화를 불러오지 못했어요')
      setMessages((rows as Msg[]) ?? [])
      setLoaded(true)
      await markRead(user.id)

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
      .select('id, sender_id, body, catalog_title, catalog_slug, catalog_thumb, created_at')
      .single()
    setBusy(false)
    if (sendErr || !data) {
      setError('메시지를 보내지 못했어요. 상대가 대화를 막았을 수 있어요.')
      return
    }
    const row = data as Msg
    setMessages((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, row]))
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

  const leave = async () => {
    const ok = window.confirm('이 대화방을 목록에서 나갈까요?\n상대방 쪽 대화는 그대로 남아요. 새 메시지가 오면 다시 나타나요.')
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
    <main className="container section" style={{ paddingBottom: 110 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Link href="/dashboard/chat" className="btn btn-ghost">← 목록</Link>
        <strong className="truncate" style={{ flex: 1 }}>{partner.company || '회원'}</strong>
        <button type="button" className="btn btn-ghost" onClick={rename}>이름</button>
        <button type="button" className="btn btn-ghost" onClick={leave}>나가기</button>
        <button type="button" className="btn btn-ghost" onClick={togglePin} aria-pressed={pinned}>
          {pinned ? '고정 해제' : '고정'}
        </button>
      </div>

      {error && <div className="notice notice-error" role="alert" style={{ marginBottom: 10 }}>{error}</div>}

      <div style={{ display: 'grid', gap: 8 }}>
        {messages.length === 0 && (
          <div className="notice notice-info">첫 메시지를 보내 보세요. 카탈로그를 첨부하면 바로 열어 볼 수 있어요.</div>
        )}
        {messages.map((m) => {
          const mine = m.sender_id === me
          return (
            <div key={m.id} style={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start' }}>
              <div style={{ maxWidth: '80%', display: 'grid', gap: 4, justifyItems: mine ? 'end' : 'start' }}>
                {m.catalog_slug && (
                  <a
                    href={`/b/${m.catalog_slug}`}
                    className="info-box"
                    style={{ display: 'flex', gap: 10, alignItems: 'center', textDecoration: 'none', color: 'inherit', padding: 10 }}
                  >
                    {m.catalog_thumb ? (
                      <img src={m.catalog_thumb} alt="" width={44} height={56} style={{ objectFit: 'cover', borderRadius: 4 }} />
                    ) : (
                      <span aria-hidden="true">📄</span>
                    )}
                    <span className="truncate" style={{ fontWeight: 600 }}>{m.catalog_title || '카탈로그'}</span>
                  </a>
                )}
                {m.body && (
                  <div
                    style={{
                      padding: '8px 12px',
                      borderRadius: 12,
                      background: mine ? 'var(--ink, #111)' : '#fff',
                      color: mine ? '#fff' : 'inherit',
                      border: mine ? 'none' : '1px solid var(--line, #e5e5e5)',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {m.body}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, fontSize: 11, color: 'var(--muted)' }}>
                  <span>{timeOf(m.created_at)}</span>
                  {!mine && (
                    <button type="button" onClick={() => report(m)} style={{ fontSize: 11, color: 'var(--muted)', background: 'none', border: 0, padding: 0, cursor: 'pointer' }}>
                      신고
                    </button>
                  )}
                </div>
              </div>
            </div>
          )
        })}
        <div ref={bottom} />
      </div>

      {catalogs && (
        <div className="panel" style={{ marginTop: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>보낼 카탈로그 선택</div>
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
          padding: '10px 12px 10px',
          background: '#fff',
          borderTop: '1px solid var(--line, #e5e5e5)',
          display: 'flex',
          gap: 8,
          alignItems: 'flex-end',
        }}
      >
        <button type="button" className="btn btn-ghost" onClick={openCatalogPicker} disabled={busy} aria-label="카탈로그 첨부">
          📎
        </button>
        <textarea
          className="input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={2000}
          rows={1}
          placeholder="메시지 입력"
          style={{ flex: 1, resize: 'none' }}
          disabled={busy}
        />
        <button type="submit" className="btn btn-primary" disabled={busy || !text.trim()}>보내기</button>
      </form>
    </main>
  )
}
