'use client'
// Viewer sheet with the publisher's AI translations, one language at a time.
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { TRANSLATE_LANGS, isTranslateLang } from '@/lib/translate/languages'

type Props = {
  slug: string
  langs: string[]
  onClose: () => void
}

type Row = { page_no: number; page_text: string }

export default function TranslationSheet({ slug, langs, onClose }: Props) {
  const available = langs.filter(isTranslateLang)
  const [lang, setLang] = useState(available[0] ?? 'en')
  const [rows, setRows] = useState<Row[] | null>(null)

  useEffect(() => {
    let alive = true
    setRows(null)
    createClient()
      .rpc('get_translations', { p_slug: slug, p_lang: lang })
      .then(({ data }) => {
        if (alive) setRows((data as Row[]) ?? [])
      })
    return () => {
      alive = false
    }
  }, [slug, lang])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="trans-title"
      style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
    >
      <div style={{ width: '100%', maxWidth: 520, maxHeight: '85vh', overflowY: 'auto', background: '#fff', color: '#111', borderRadius: '16px 16px 0 0', padding: '18px 18px calc(20px + env(safe-area-inset-bottom))', boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <h2 id="trans-title" style={{ fontSize: 17, margin: 0 }}>번역</h2>
          <button type="button" onClick={onClose} style={{ padding: '8px 12px', border: '1px solid #ddd', borderRadius: 8, background: '#fff' }}>닫기</button>
        </div>
        <p style={{ fontSize: 12, color: '#777', margin: '6px 0 0' }}>AI가 번역한 글이라 틀린 곳이 있을 수 있어요. 상품명, 가격은 원문도 함께 확인해 주세요.</p>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '12px 0' }}>
          {available.map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLang(l)}
              style={{ padding: '8px 12px', borderRadius: 8, border: 0, background: l === lang ? '#111' : '#eee', color: l === lang ? '#fff' : '#333' }}
            >
              {TRANSLATE_LANGS[l].label}
            </button>
          ))}
        </div>

        {rows === null ? (
          <p style={{ fontSize: 14, color: '#777' }}>불러오는 중...</p>
        ) : rows.length === 0 ? (
          <p style={{ fontSize: 14, color: '#777' }}>번역이 없어요.</p>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            {rows.map((r) => (
              <section key={r.page_no}>
                <div style={{ fontSize: 12, color: '#888' }}>{r.page_no}쪽</div>
                <p style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap', margin: '4px 0 0' }}>{r.page_text}</p>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
