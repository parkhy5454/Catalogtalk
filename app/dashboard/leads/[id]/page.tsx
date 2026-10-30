'use client'
// Owner's list of contacts collected from a catalog. Only the owner can read these rows (RLS).
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

type Lead = {
  id: string
  name: string
  contact: string
  marketing_consent: boolean
  created_at: string
}

// Spreadsheet programs run cells that start with = + - @ as formulas; prefix them to keep them text.
function csvCell(v: string): string {
  const safe = /^[=+\-@]/.test(v) ? `'${v}` : v
  return `"${safe.replace(/"/g, '""')}"`
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString('ko-KR', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function LeadsPage() {
  const { id } = useParams<{ id: string }>()
  const supabase = createClient()
  const [title, setTitle] = useState('')
  const [leads, setLeads] = useState<Lead[] | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [book, rows] = await Promise.all([
      supabase.from('flipbooks').select('title').eq('id', id).maybeSingle(),
      supabase
        .from('flipbook_leads')
        .select('id, name, contact, marketing_consent, created_at')
        .eq('flipbook_id', id)
        .order('created_at', { ascending: false })
        .limit(5000),
    ])
    if (!book.data) {
      setNotFound(true)
      return
    }
    setTitle(book.data.title)
    if (rows.error) setError('목록을 불러오지 못했어요')
    else setLeads((rows.data as Lead[]) ?? [])
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const remove = async (leadId: string) => {
    if (!window.confirm('이 연락처를 삭제할까요? 되돌릴 수 없어요.')) return
    const { error: delErr } = await supabase.from('flipbook_leads').delete().eq('id', leadId)
    if (delErr) {
      setError('삭제하지 못했어요')
      return
    }
    setLeads((prev) => (prev ? prev.filter((l) => l.id !== leadId) : prev))
  }

  const downloadCsv = () => {
    if (!leads || leads.length === 0) return
    const header = ['받은 날짜', '이름', '연락처', '마케팅 수신 동의']
    const lines = leads.map((l) => [
      csvCell(fmtDate(l.created_at)),
      csvCell(l.name),
      csvCell(l.contact),
      csvCell(l.marketing_consent ? '동의' : '미동의'),
    ].join(','))
    // BOM so Excel reads Korean text correctly
    const blob = new Blob(['﻿' + [header.map(csvCell).join(','), ...lines].join('\r\n')], {
      type: 'text/csv;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${title || 'leads'}-리드.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  if (notFound) {
    return (
      <main className="container section">
        <div className="notice notice-error">자료를 찾을 수 없어요.</div>
        <Link href="/dashboard/folders" className="btn btn-ghost btn-block" style={{ marginTop: 16 }}>
          My Book으로 돌아가기
        </Link>
      </main>
    )
  }

  return (
    <main className="container section">
      <Link href={`/dashboard/stats/${id}`} className="btn btn-ghost" style={{ marginBottom: 12 }}>
        ← 통계
      </Link>

      <section className="panel">
        <div className="panel-head">
          <h1 className="panel-title" style={{ wordBreak: 'keep-all' }}>{title} 리드</h1>
          <button type="button" className="btn btn-primary" onClick={downloadCsv} disabled={!leads || leads.length === 0}>
            CSV 받기
          </button>
        </div>
        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
          동의한 사람의 연락처만 있어요. 1년이 지난 항목은 자동 삭제되고, 필요하면 여기서 바로 지울 수 있어요.
          CSV 파일에는 개인정보가 들어 있으니 안전하게 보관해 주세요.
        </p>

        {error && <div className="notice notice-error" role="alert" style={{ marginTop: 12 }}>{error}</div>}

        {leads === null ? (
          <div className="skeleton" style={{ height: 120, marginTop: 12 }} aria-hidden="true" />
        ) : leads.length === 0 ? (
          <div className="notice notice-info" style={{ marginTop: 12 }}>
            아직 받은 리드가 없어요. 통계 화면에서 리드 수집을 켜면 여기에 쌓여요.
          </div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0', display: 'grid', gap: 8 }}>
            {leads.map((l) => (
              <li key={l.id} className="info-box" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                <div style={{ minWidth: 0 }}>
                  <strong className="truncate" style={{ display: 'block' }}>{l.name}</strong>
                  <span className="truncate" style={{ display: 'block', fontSize: 13 }}>{l.contact}</span>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {fmtDate(l.created_at)}{l.marketing_consent ? ' · 마케팅 동의' : ''}
                  </span>
                </div>
                <button type="button" className="btn btn-ghost" onClick={() => remove(l.id)}>삭제</button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
