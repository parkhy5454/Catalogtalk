'use client'
// Owner sets whether a catalog appears in the public buyer directory, with a category and a short summary.
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { DIRECTORY_CATEGORIES, SUMMARY_MAX } from '@/lib/directory'

export default function DirectorySettingsPage() {
  const { id } = useParams<{ id: string }>()
  const supabase = createClient()
  const [loaded, setLoaded] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const [title, setTitle] = useState('')
  const [listed, setListed] = useState(false)
  const [category, setCategory] = useState<string>('기타')
  const [summary, setSummary] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)

  useEffect(() => {
    ;(async () => {
      const { data } = await supabase.from('flipbooks').select('title, listed, category, summary').eq('id', id).maybeSingle()
      if (!data) return setNotFound(true)
      setTitle(data.title)
      setListed(data.listed === true)
      setCategory(data.category ?? '기타')
      setSummary(data.summary ?? '')
      setLoaded(true)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setNotice(null)
    const { error } = await supabase
      .from('flipbooks')
      .update({ listed, category, summary: summary.trim() || null })
      .eq('id', id)
    setBusy(false)
    if (error) return setNotice({ kind: 'error', text: '저장하지 못했어요' })
    setNotice({ kind: 'success', text: '저장했어요.' })
  }

  if (notFound) {
    return (
      <main className="container section">
        <div className="notice notice-error">자료를 찾을 수 없어요.</div>
        <Link href="/dashboard/folders" className="btn btn-ghost btn-block" style={{ marginTop: 16 }}>My Book으로 돌아가기</Link>
      </main>
    )
  }

  return (
    <main className="container section">
      <Link href={`/dashboard/stats/${id}`} className="btn btn-ghost" style={{ marginBottom: 12 }}>← 통계</Link>
      <section className="panel">
        <div className="panel-head">
          <h1 className="panel-title" style={{ wordBreak: 'keep-all' }}>{title} 바이어 디렉터리</h1>
        </div>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
          켜면 공개 디렉터리에 올라가요. 링크를 끄거나 자료를 삭제하면 목록에서도 사라져요.
          올리기 전에 저작권이 있는 자료인지 확인해 주세요.
        </p>
        {!loaded ? (
          <div className="skeleton" style={{ height: 160, marginTop: 12 }} aria-hidden="true" />
        ) : (
          <form onSubmit={save} className="form-stack" style={{ marginTop: 12 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
              <input type="checkbox" checked={listed} onChange={(e) => setListed(e.target.checked)} disabled={busy} />
              디렉터리에 공개하기
            </label>
            <label className="field">
              <span className="field-label">분류</span>
              <select className="input" value={category} onChange={(e) => setCategory(e.target.value)} disabled={busy}>
                {DIRECTORY_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="field">
              <span className="field-label">한 줄 소개 ({summary.length}/{SUMMARY_MAX})</span>
              <textarea className="input" value={summary} onChange={(e) => setSummary(e.target.value.slice(0, SUMMARY_MAX))} rows={3} disabled={busy} style={{ resize: 'vertical' }} />
            </label>
            {notice && (
              <div className={`notice ${notice.kind === 'error' ? 'notice-error' : 'notice-success'}`} role="status">{notice.text}</div>
            )}
            <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{busy ? '저장 중...' : '저장'}</button>
          </form>
        )}
      </section>
    </main>
  )
}
