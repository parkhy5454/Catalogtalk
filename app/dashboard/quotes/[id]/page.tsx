'use client'
// Owner's inbox of quote requests for one catalog. Only the team or owner can read these rows (RLS).
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

type Quote = {
  id: string
  name: string
  contact: string
  company: string | null
  memo: string
  status: 'new' | 'done'
  created_at: string
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString('ko-KR', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export default function QuotesPage() {
  const { id } = useParams<{ id: string }>()
  const supabase = createClient()
  const [title, setTitle] = useState('')
  const [rows, setRows] = useState<Quote[] | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [book, quotes] = await Promise.all([
      supabase.from('flipbooks').select('title').eq('id', id).maybeSingle(),
      supabase
        .from('quote_requests')
        .select('id, name, contact, company, memo, status, created_at')
        .eq('flipbook_id', id)
        .order('created_at', { ascending: false })
        .limit(500),
    ])
    if (!book.data) return setNotFound(true)
    setTitle(book.data.title)
    if (quotes.error) setError('목록을 불러오지 못했어요')
    else setRows((quotes.data as Quote[]) ?? [])
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const toggleDone = async (q: Quote) => {
    const next = q.status === 'new' ? 'done' : 'new'
    const { error: err } = await supabase.from('quote_requests').update({ status: next }).eq('id', q.id)
    if (err) return setError('상태를 바꾸지 못했어요')
    setRows((prev) => (prev ? prev.map((x) => (x.id === q.id ? { ...x, status: next } : x)) : prev))
  }

  const remove = async (qid: string) => {
    if (!window.confirm('이 요청을 삭제할까요? 되돌릴 수 없어요.')) return
    const { error: err } = await supabase.from('quote_requests').delete().eq('id', qid)
    if (err) return setError('삭제하지 못했어요')
    setRows((prev) => (prev ? prev.filter((x) => x.id !== qid) : prev))
  }

  if (notFound) {
    return (
      <main className="container section">
        <div className="notice notice-error">자료를 찾을 수 없어요.</div>
        <Link href="/dashboard/folders" className="btn btn-ghost btn-block" style={{ marginTop: 16 }}>My Book으로 돌아가기</Link>
      </main>
    )
  }

  const open = rows?.filter((r) => r.status === 'new').length ?? 0

  return (
    <main className="container section">
      <Link href={`/dashboard/stats/${id}`} className="btn btn-ghost" style={{ marginBottom: 12 }}>← 통계</Link>

      <section className="panel">
        <div className="panel-head">
          <h1 className="panel-title" style={{ wordBreak: 'keep-all' }}>{title} 견적 요청</h1>
        </div>
        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
          아직 처리하지 않은 요청 {open}건. 요청은 1년이 지나면 자동 삭제돼요.
        </p>

        {error && <div className="notice notice-error" role="alert" style={{ marginTop: 12 }}>{error}</div>}

        {rows === null ? (
          <div className="skeleton" style={{ height: 120, marginTop: 12 }} aria-hidden="true" />
        ) : rows.length === 0 ? (
          <div className="notice notice-info" style={{ marginTop: 12 }}>아직 견적 요청이 없어요. 통계 화면에서 견적 요청 받기를 켜면 여기에 모여요.</div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0', display: 'grid', gap: 8 }}>
            {rows.map((q) => (
              <li key={q.id} className="info-box" style={{ display: 'grid', gap: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                  <strong className="truncate">{q.company ? `${q.company} · ` : ''}{q.name}</strong>
                  <span style={{ fontSize: 12, color: q.status === 'new' ? '#c0392b' : 'var(--muted)', whiteSpace: 'nowrap' }}>
                    {q.status === 'new' ? '미처리' : '처리 완료'}
                  </span>
                </div>
                <span style={{ fontSize: 13 }}>{q.contact}</span>
                <p style={{ fontSize: 13, margin: 0, whiteSpace: 'pre-wrap' }}>{q.memo}</p>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{fmtDate(q.created_at)}</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" className="btn btn-ghost" onClick={() => toggleDone(q)}>
                    {q.status === 'new' ? '처리 완료로 표시' : '미처리로 되돌리기'}
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => remove(q.id)}>삭제</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
