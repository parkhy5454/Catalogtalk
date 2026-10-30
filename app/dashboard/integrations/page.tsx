'use client'
// CRM connections: send lead and quote events to an address the owner chooses (https only).
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { isSafeWebhookUrl } from '@/lib/webhook-url'

type Endpoint = { id: string; url: string; secret: string; enabled: boolean }
type Delivery = {
  id: string
  event: string
  status: 'pending' | 'delivered' | 'failed'
  attempts: number
  last_code: number | null
  last_error: string | null
  created_at: string
  endpoint_id: string
}

const MAX_ENDPOINTS = 5

function newSecret(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

const STATUS_LABEL: Record<Delivery['status'], string> = { pending: '대기 중', delivered: '전달됨', failed: '실패' }
const EVENT_LABEL: Record<string, string> = { 'lead.created': '리드 수집', 'quote.requested': '견적 요청', ping: '테스트' }

export default function IntegrationsPage() {
  const supabase = createClient()
  const [endpoints, setEndpoints] = useState<Endpoint[] | null>(null)
  const [deliveries, setDeliveries] = useState<Delivery[]>([])
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const [revealed, setRevealed] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [eps, logs] = await Promise.all([
      supabase.from('webhook_endpoints').select('id, url, secret, enabled').order('created_at', { ascending: true }),
      supabase
        .from('webhook_deliveries')
        .select('id, event, status, attempts, last_code, last_error, created_at, endpoint_id')
        .order('created_at', { ascending: false })
        .limit(20),
    ])
    setEndpoints((eps.data as Endpoint[]) ?? [])
    setDeliveries((logs.data as Delivery[]) ?? [])
  }, [])

  useEffect(() => {
    void load()
    // Pick up any retries that are due while the screen is open.
    fetch('/api/webhooks/dispatch', { method: 'POST' }).catch(() => undefined)
  }, [load])

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    const clean = url.trim()
    if (!isSafeWebhookUrl(clean)) {
      setMessage({ kind: 'error', text: 'https로 시작하는 공개 주소만 등록할 수 있어요 (localhost나 내부 주소는 안 돼요)' })
      return
    }
    setBusy(true)
    setMessage(null)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      setBusy(false)
      return
    }
    const { error } = await supabase.from('webhook_endpoints').insert({ user_id: user.id, url: clean, secret: newSecret(), enabled: true })
    setBusy(false)
    if (error) return setMessage({ kind: 'error', text: error.message.includes('5개') ? `연동 주소는 ${MAX_ENDPOINTS}개까지 등록할 수 있어요` : '추가하지 못했어요' })
    setUrl('')
    setMessage({ kind: 'success', text: '추가했어요. 아래 비밀 키를 복사해 두세요.' })
    await load()
  }

  const toggle = async (ep: Endpoint) => {
    const { error } = await supabase.from('webhook_endpoints').update({ enabled: !ep.enabled }).eq('id', ep.id)
    if (error) return setMessage({ kind: 'error', text: '바꾸지 못했어요' })
    await load()
  }

  const remove = async (ep: Endpoint) => {
    if (!window.confirm('이 연동을 삭제할까요? 보내지 않은 기록도 함께 사라져요.')) return
    const { error } = await supabase.from('webhook_endpoints').delete().eq('id', ep.id)
    if (error) return setMessage({ kind: 'error', text: '삭제하지 못했어요' })
    await load()
  }

  const ping = async (ep: Endpoint) => {
    setBusy(true)
    setMessage(null)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return setBusy(false)
    const { error } = await supabase.from('webhook_deliveries').insert({
      endpoint_id: ep.id,
      user_id: user.id,
      event: 'ping',
      payload: { event: 'ping', sent_at: new Date().toISOString() },
    })
    if (error) {
      setBusy(false)
      return setMessage({ kind: 'error', text: '테스트를 만들지 못했어요' })
    }
    await fetch('/api/webhooks/dispatch', { method: 'POST' }).catch(() => undefined)
    setBusy(false)
    setMessage({ kind: 'success', text: '테스트를 보냈어요. 아래 전송 기록에서 결과를 볼 수 있어요.' })
    await load()
  }

  const retryNow = async () => {
    setBusy(true)
    await fetch('/api/webhooks/dispatch', { method: 'POST' }).catch(() => undefined)
    setBusy(false)
    await load()
  }

  const urlOf = (id: string) => endpoints?.find((e) => e.id === id)?.url ?? '삭제된 연동'

  return (
    <main className="container section">
      <section className="panel">
        <div className="panel-head">
          <h1 className="panel-title">외부 연동</h1>
          <Link href="/dashboard/settings" className="btn btn-ghost">← 설정</Link>
        </div>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
          리드가 들어오거나 견적 요청이 오면 등록한 주소로 자동으로 알려드려요. 고객 관리(CRM) 도구나 자동화 도구(Zapier 등)의 주소를 넣어 쓰세요.
          연락처가 함께 전달되니, 받는 곳이 믿을 만한지 확인해 주세요.
        </p>

        {message && (
          <div className={`notice ${message.kind === 'error' ? 'notice-error' : 'notice-success'}`} role="status" style={{ marginTop: 12 }}>
            {message.text}
          </div>
        )}

        <form onSubmit={add} style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://받는-주소" disabled={busy} style={{ flex: 1 }} />
          <button type="submit" className="btn btn-primary" disabled={busy || !url.trim() || (endpoints?.length ?? 0) >= MAX_ENDPOINTS}>추가</button>
        </form>

        {endpoints === null ? (
          <div className="skeleton" style={{ height: 80, marginTop: 12 }} aria-hidden="true" />
        ) : endpoints.length === 0 ? (
          <div className="notice notice-info" style={{ marginTop: 12 }}>아직 연동한 주소가 없어요.</div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0', display: 'grid', gap: 8 }}>
            {endpoints.map((ep) => (
              <li key={ep.id} className="info-box" style={{ display: 'grid', gap: 8, fontSize: 13 }}>
                <div className="truncate"><strong>{ep.url}</strong></div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  <button type="button" className={ep.enabled ? 'btn btn-primary' : 'btn btn-ghost'} onClick={() => toggle(ep)}>
                    {ep.enabled ? '켜짐' : '꺼짐'}
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => ping(ep)} disabled={busy}>테스트 보내기</button>
                  <button type="button" className="btn btn-ghost" onClick={() => setRevealed(revealed === ep.id ? null : ep.id)}>
                    {revealed === ep.id ? '비밀 키 숨기기' : '비밀 키 보기'}
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => remove(ep)}>삭제</button>
                </div>
                {revealed === ep.id && (
                  <code style={{ wordBreak: 'break-all', fontSize: 12, background: '#f4f4f4', padding: 8, borderRadius: 8 }}>{ep.secret}</code>
                )}
              </li>
            ))}
          </ul>
        )}

        <h2 className="panel-title" style={{ fontSize: 16, marginTop: 24 }}>최근 전송 기록</h2>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
          <button type="button" className="btn btn-ghost" onClick={retryNow} disabled={busy}>지금 다시 보내기</button>
        </div>
        {deliveries.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 8 }}>아직 보낸 기록이 없어요.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', display: 'grid', gap: 6, fontSize: 12 }}>
            {deliveries.map((d) => (
              <li key={d.id} className="info-box" style={{ display: 'grid', gap: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <strong>{EVENT_LABEL[d.event] ?? d.event} · {STATUS_LABEL[d.status]}</strong>
                  <span style={{ color: 'var(--muted)' }}>{new Date(d.created_at).toLocaleString('ko-KR')}</span>
                </div>
                <span className="truncate" style={{ color: 'var(--muted)' }}>{urlOf(d.endpoint_id)}</span>
                {(d.last_error || d.status !== 'pending') && (
                  <span style={{ color: d.status === 'failed' ? '#c0392b' : 'var(--muted)' }}>
                    {d.last_code ? `응답 ${d.last_code}` : ''}{d.last_error ? ` · ${d.last_error}` : ''}{d.attempts ? ` · 시도 ${d.attempts}회` : ''}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        <details style={{ marginTop: 24, fontSize: 13 }}>
          <summary style={{ cursor: 'pointer' }}>받는 쪽에서 확인하는 방법</summary>
          <p style={{ color: 'var(--muted)', marginTop: 8 }}>
            요청마다 <code>X-Catalogtalk-Signature</code> 헤더가 붙어요. 값은 <code>sha256=</code> 뒤에 <code>타임스탬프.본문</code>을 비밀 키로 HMAC-SHA256 한 결과예요.
            타임스탬프는 <code>X-Catalogtalk-Timestamp</code>에 있어요. 같은 <code>X-Catalogtalk-Event-Id</code>는 한 번만 처리하면 중복을 막을 수 있어요.
            실패하면 1분, 10분, 1시간, 6시간, 24시간 뒤에 다시 보내고, 여섯 번 모두 실패하면 멈춰요.
          </p>
        </details>
      </section>
    </main>
  )
}
