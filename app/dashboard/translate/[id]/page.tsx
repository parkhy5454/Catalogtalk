'use client'
// Owner's translation screen: translates the catalog one page at a time, then shows it to visitors
// in the viewer's "번역" sheet.
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { FREE_TRANSLATE_PAGES, TRANSLATE_LANGS, type TranslateLang } from '@/lib/translate/languages'

export default function TranslatePage() {
  const { id } = useParams<{ id: string }>()
  const supabase = createClient()
  const [title, setTitle] = useState('')
  const [pageCount, setPageCount] = useState(0)
  const [notFound, setNotFound] = useState(false)
  const [lang, setLang] = useState<TranslateLang>('en')
  const [doneSet, setDoneSet] = useState<Set<number>>(new Set())
  const [used, setUsed] = useState(0)
  const [running, setRunning] = useState(false)
  const stopRef = useRef(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [book, rows, usage] = await Promise.all([
      supabase.from('flipbooks').select('title, page_count').eq('id', id).maybeSingle(),
      supabase.from('flipbook_translations').select('page_no').eq('flipbook_id', id).eq('lang', lang),
      supabase.from('translation_usage').select('id', { count: 'exact', head: true }),
    ])
    if (!book.data) return setNotFound(true)
    setTitle(book.data.title)
    setPageCount(book.data.page_count ?? 0)
    setDoneSet(new Set(((rows.data as { page_no: number }[]) ?? []).map((r) => r.page_no)))
    setUsed(usage.count ?? 0)
  }, [id, lang])

  useEffect(() => {
    void load()
  }, [load])

  const remaining = Math.max(0, FREE_TRANSLATE_PAGES - used)
  const total = pageCount
  const done = doneSet.size

  const run = async () => {
    setError(null)
    setRunning(true)
    stopRef.current = false
    try {
      for (let p = 1; p <= total; p++) {
        if (stopRef.current) break
        if (doneSet.has(p)) continue
        const res = await fetch('/api/translate/page', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ flipbook_id: id, lang, page_no: p }),
        })
        const body = (await res.json().catch(() => ({}))) as { error?: string; charged?: boolean }
        if (!res.ok) {
          setError(body.error ?? '번역하지 못했어요')
          break
        }
        setDoneSet((prev) => new Set(prev).add(p))
        if (body.charged) setUsed((u) => u + 1)
      }
    } finally {
      setRunning(false)
    }
  }

  const clearLang = async () => {
    if (!window.confirm(`${TRANSLATE_LANGS[lang].label} 번역을 모두 지울까요? 방문자에게도 바로 사라져요.`)) return
    const { error: err } = await supabase.from('flipbook_translations').delete().eq('flipbook_id', id).eq('lang', lang)
    if (err) return setError('지우지 못했어요')
    await load()
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
          <h1 className="panel-title" style={{ wordBreak: 'keep-all' }}>{title} 번역</h1>
        </div>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
          쪽마다 글자를 읽고 번역해요. 번역문은 방문자가 뷰어의 '번역' 버튼에서 볼 수 있어요.
          AI가 번역하므로 틀린 곳이 있을 수 있어요. 공개 전에 꼭 확인해 주세요.
        </p>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 14 }}>
          {(Object.keys(TRANSLATE_LANGS) as TranslateLang[]).map((l) => (
            <button
              key={l}
              type="button"
              className={l === lang ? 'btn btn-primary' : 'btn btn-ghost'}
              onClick={() => setLang(l)}
              disabled={running}
            >
              {TRANSLATE_LANGS[l].label}
            </button>
          ))}
        </div>

        <div className="info-box" style={{ marginTop: 14, fontSize: 13 }}>
          <div>{TRANSLATE_LANGS[lang].label} 번역: {done} / {total}쪽</div>
          <div style={{ color: 'var(--muted)', marginTop: 4 }}>
            무료 번역 남은 쪽 수: {remaining} / {FREE_TRANSLATE_PAGES}쪽
          </div>
        </div>

        {error && <div className="notice notice-error" role="alert" style={{ marginTop: 12 }}>{error}</div>}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
          {running ? (
            <button type="button" className="btn btn-ghost" onClick={() => { stopRef.current = true }}>
              멈추기 (지금까지 번역은 남아요)
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              onClick={run}
              disabled={total === 0 || done >= total || remaining === 0}
            >
              {done >= total && total > 0 ? '번역 완료' : done > 0 ? '이어서 번역하기' : '번역 만들기'}
            </button>
          )}
          {done > 0 && !running && (
            <button type="button" className="btn btn-ghost" onClick={clearLang}>이 언어 번역 지우기</button>
          )}
        </div>
        {remaining === 0 && done < total && (
          <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>무료 번역 한도를 모두 썼어요. 추가 번역은 유료 크레딧 출시 후 열려요.</p>
        )}
      </section>
    </main>
  )
}
