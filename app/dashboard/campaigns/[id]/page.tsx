'use client'
// Automated reminders (set per catalog) and campaign results: sent, clicked, and converted customers.
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

type Stat = { kind: string; sent: number; clicked: number; converted: number; last_sent: string | null }

const KIND_LABEL: Record<string, string> = {
  notice: '소식 메일',
  reorder: '재구매 안내',
  unviewed: '미열람 리마인드',
  quote_reminder: '견적 리마인드',
}

const pct = (a: number, b: number) => (b === 0 ? '-' : `${Math.round((a / b) * 100)}%`)

export default function CampaignsPage() {
  const { id } = useParams<{ id: string }>()
  const [title, setTitle] = useState('')
  const [notFound, setNotFound] = useState(false)
  const [unviewed, setUnviewed] = useState('')
  const [quote, setQuote] = useState('')
  const [stats, setStats] = useState<Stat[] | null>(null)
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)

  const load = useCallback(async () => {
    const supabase = createClient()
    const [book, st] = await Promise.all([
      supabase.from('flipbooks').select('title, remind_unviewed_days, remind_quote_days').eq('id', id).maybeSingle(),
      supabase.rpc('get_campaign_stats', { p_flipbook: id }),
    ])
    if (!book.data) return setNotFound(true)
    setTitle(book.data.title)
    setUnviewed(book.data.remind_unviewed_days ? String(book.data.remind_unviewed_days) : '')
    setQuote(book.data.remind_quote_days ? String(book.data.remind_quote_days) : '')
    setStats((st.data as Stat[]) ?? [])
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (patch: { remind_unviewed_days?: number | null; remind_quote_days?: number | null }) => {
    const { error } = await createClient().from('flipbooks').update(patch).eq('id', id)
    if (error) return setNotice({ kind: 'error', text: '저장하지 못했어요' })
    setNotice({ kind: 'success', text: '저장했어요' })
    await load()
  }

  if (notFound) {
    return (
      <main className="container section">
        <div className="notice notice-error">자료를 찾을 수 없어요.</div>
        <Link href="/dashboard" className="btn btn-ghost btn-block" style={{ marginTop: 16 }}>대시보드로 돌아가기</Link>
      </main>
    )
  }

  return (
    <main className="container section">
      <Link href={`/dashboard/stats/${id}`} className="btn btn-ghost" style={{ marginBottom: 12 }}>← 통계</Link>
      <h1 className="panel-title" style={{ wordBreak: 'keep-all' }}>{title} · 자동 리마인드·캠페인</h1>
      <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
        마케팅 수신에 동의한 고객에게만 보내요. 메일 수신거부 링크가 들어가요.
      </p>
      {notice && <div className={`notice ${notice.kind === 'error' ? 'notice-error' : 'notice-success'}`} role="status" style={{ marginTop: 12 }}>{notice.text}</div>}

      <section className="panel" style={{ marginTop: 14 }}>
        <h2 className="panel-title" style={{ fontSize: 16 }}>자동 리마인드</h2>
        <div className="form-stack" style={{ marginTop: 10 }}>
          <label className="field">
            <span className="field-label">미열람 고객 알림 (이 기간 동안 열람하지 않은 고객)</span>
            <select className="input" value={unviewed} onChange={(e) => save({ remind_unviewed_days: e.target.value ? Number(e.target.value) : null })}>
              <option value="">끄기</option>
              <option value="7">7일</option>
              <option value="14">14일</option>
              <option value="30">30일</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">견적 미완료 리마인드 (처리되지 않은 견적이 이 기간을 넘으면)</span>
            <select className="input" value={quote} onChange={(e) => save({ remind_quote_days: e.target.value ? Number(e.target.value) : null })}>
              <option value="">끄기</option>
              <option value="1">1일</option>
              <option value="3">3일</option>
              <option value="7">7일</option>
            </select>
          </label>
        </div>
        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10 }}>
          재구매 안내는 상품 관리 화면의 재구매 알림 설정으로 따로 켜요. 자동 메일은 하루 한 번 정리 작업에서 보내요.
        </p>
      </section>

      <section className="panel" style={{ marginTop: 16 }}>
        <h2 className="panel-title" style={{ fontSize: 16 }}>캠페인 성과</h2>
        {stats === null ? (
          <div className="skeleton" style={{ height: 120, marginTop: 8 }} aria-hidden="true" />
        ) : stats.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 8 }}>아직 보낸 메일이 없어요.</p>
        ) : (
          <div style={{ overflowX: 'auto', marginTop: 10 }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>
                  <th style={{ padding: '6px 4px' }}>종류</th>
                  <th style={{ textAlign: 'right' }}>보냄</th>
                  <th style={{ textAlign: 'right' }}>클릭</th>
                  <th style={{ textAlign: 'right' }}>클릭률</th>
                  <th style={{ textAlign: 'right' }}>전환</th>
                  <th style={{ textAlign: 'right' }}>전환율</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((s) => (
                  <tr key={s.kind} style={{ borderBottom: '1px solid #eee' }}>
                    <td style={{ padding: '6px 4px' }}>{KIND_LABEL[s.kind] ?? s.kind}</td>
                    <td style={{ textAlign: 'right' }}>{s.sent}</td>
                    <td style={{ textAlign: 'right' }}>{s.clicked}</td>
                    <td style={{ textAlign: 'right' }}>{pct(s.clicked, s.sent)}</td>
                    <td style={{ textAlign: 'right' }}>{s.converted}</td>
                    <td style={{ textAlign: 'right' }}>{pct(s.converted, s.sent)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10 }}>
          전환은 메일을 받은 뒤 14일 안에 같은 연락처로 주문이나 견적 요청이 들어온 고객 수예요. 클릭은 메일 링크를 누른 고객 수예요.
        </p>
      </section>
    </main>
  )
}
