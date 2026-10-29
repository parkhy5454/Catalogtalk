'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'

const FOLDER_NAME_MAX = 30

type Folder = { id: string; name: string }
type FolderBook = {
  id: string
  title: string
  slug: string
  thumb_url: string | null
  page_count: number
  folder_id: string | null
}

function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : (err as { message?: string })?.message ?? String(err)
  if (/row-level security|policy/i.test(msg)) return '권한이 없어요. 다시 로그인해 주세요.'
  return msg
}

export default function FoldersPage() {
  const supabase = createClient()
  const [userId, setUserId] = useState<string | null>(null)
  const [folders, setFolders] = useState<Folder[]>([])
  const [books, setBooks] = useState<FolderBook[]>([])
  // Which folder is open: a folder id, 'none' for unfiled, or null for all closed.
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)

  const load = useCallback(
    async (uid: string) => {
      const [fRes, bRes] = await Promise.all([
        supabase.from('folders').select('id, name').eq('user_id', uid).order('created_at', { ascending: true }),
        supabase
          .from('flipbooks')
          .select('id, title, slug, thumb_url, page_count, folder_id')
          .eq('user_id', uid)
          .order('created_at', { ascending: false }),
      ])
      if (fRes.error) return setMessage({ kind: 'error', text: friendlyError(fRes.error) })
      if (bRes.error) return setMessage({ kind: 'error', text: friendlyError(bRes.error) })
      setFolders((fRes.data as Folder[]) ?? [])
      setBooks((bRes.data as FolderBook[]) ?? [])
    },
    [supabase]
  )

  useEffect(() => {
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      setUserId(user.id)
      await load(user.id)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const booksIn = (key: string) =>
    key === 'none' ? books.filter((b) => !b.folder_id) : books.filter((b) => b.folder_id === key)

  const handleCreate = async () => {
    const name = newName.trim().slice(0, FOLDER_NAME_MAX)
    if (!name || !userId) return
    setMessage(null)
    const { data, error } = await supabase
      .from('folders')
      .insert({ user_id: userId, name })
      .select('id, name')
      .single()
    if (error) return setMessage({ kind: 'error', text: friendlyError(error) })
    setFolders((prev) => [...prev, data as Folder])
    setNewName('')
    setOpenKey((data as Folder).id)
    setMessage({ kind: 'success', text: `"${name}" 폴더를 만들었어요` })
  }

  const handleRename = async (folder: Folder) => {
    const next = window.prompt('새 폴더 이름', folder.name)?.trim().slice(0, FOLDER_NAME_MAX)
    if (!next || next === folder.name) return
    const { error } = await supabase.from('folders').update({ name: next }).eq('id', folder.id)
    if (error) return setMessage({ kind: 'error', text: friendlyError(error) })
    setFolders((prev) => prev.map((f) => (f.id === folder.id ? { ...f, name: next } : f)))
  }

  const handleDelete = async (folder: Folder) => {
    const ok = window.confirm(`"${folder.name}" 폴더를 삭제할까요?\n안의 플립북은 삭제되지 않고 '폴더 없음'으로 옮겨져요.`)
    if (!ok || !userId) return
    const { error } = await supabase.from('folders').delete().eq('id', folder.id)
    if (error) return setMessage({ kind: 'error', text: friendlyError(error) })
    setMessage({ kind: 'success', text: `"${folder.name}" 폴더를 삭제했어요` })
    setOpenKey(null)
    await load(userId)
  }

  const handleMove = async (book: FolderBook, folderId: string) => {
    const nextId = folderId || null
    const { error } = await supabase.from('flipbooks').update({ folder_id: nextId }).eq('id', book.id)
    if (error) return setMessage({ kind: 'error', text: friendlyError(error) })
    setBooks((prev) => prev.map((b) => (b.id === book.id ? { ...b, folder_id: nextId } : b)))
  }

  const toggle = (key: string) => setOpenKey((cur) => (cur === key ? null : key))

  const renderBooks = (key: string) => {
    const list = booksIn(key)
    if (list.length === 0) {
      return <div className="empty" style={{ padding: 16 }}><div style={{ fontSize: 13 }}>이 폴더에 플립북이 없어요</div></div>
    }
    return (
      <ul className="fb-list" style={{ marginTop: 10 }}>
        {list.map((b) => (
          <li key={b.id} className="fb-item">
            {b.thumb_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="fb-thumb" src={b.thumb_url} alt="" loading="lazy" decoding="async" />
            ) : (
              <div className="fb-thumb" aria-hidden="true" />
            )}
            <div className="fb-body">
              <div className="fb-title truncate" title={b.title}>{b.title}</div>
              <div className="fb-meta">
                {b.page_count ? <span className="chip">{b.page_count}쪽</span> : <span className="chip">뷰어 변환 필요</span>}
              </div>
              <label className="field" style={{ marginTop: 8 }}>
                <span className="field-label">폴더 이동</span>
                <select className="input" value={b.folder_id ?? ''} onChange={(e) => handleMove(b, e.target.value)}>
                  <option value="">폴더 없음</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="fb-actions">
              {b.page_count ? (
                <a className="btn btn-primary" href={`/b/${b.slug}`} target="_blank" rel="noopener">보기</a>
              ) : (
                <Link className="btn btn-ghost" href="/dashboard">홈에서 변환</Link>
              )}
            </div>
          </li>
        ))}
      </ul>
    )
  }

  return (
    <main className="container section">
      <section className="panel" aria-labelledby="folders-title">
        <div className="panel-head">
          <h1 className="panel-title" id="folders-title">폴더</h1>
        </div>
        <p style={{ fontSize: 14, color: '#555', margin: '0 0 14px' }}>
          폴더를 누르면 안에 있는 플립북이 보여요. 다른 폴더로 옮길 때는 플립북 아래의 &quot;폴더 이동&quot;을 이용해 주세요.
        </p>

        <div className="fb-actions-row">
          <input
            className="input"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="새 폴더 이름"
            maxLength={FOLDER_NAME_MAX}
            aria-label="새 폴더 이름"
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreate()
            }}
          />
          <button type="button" className="btn btn-primary" onClick={handleCreate} disabled={!newName.trim()}>
            폴더 추가
          </button>
        </div>

        {message && (
          <div className={`notice ${message.kind === 'error' ? 'notice-error' : 'notice-success'}`} role="status" style={{ marginTop: 16 }}>
            {message.text}
          </div>
        )}

        <ul className="fb-list" style={{ marginTop: 16 }}>
          {folders.map((f) => {
            const open = openKey === f.id
            return (
              <li key={f.id} className="fb-item" style={{ display: 'block' }}>
                <div className="fb-actions-row" style={{ alignItems: 'center' }}>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    aria-expanded={open}
                    onClick={() => toggle(f.id)}
                    style={{ flex: 1, justifyContent: 'flex-start', minWidth: 0 }}
                  >
                    <span className="truncate">{open ? '▾' : '▸'} 📁 {f.name} ({booksIn(f.id).length})</span>
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => handleRename(f)}>이름 변경</button>
                  <button type="button" className="btn btn-danger" onClick={() => handleDelete(f)}>삭제</button>
                </div>
                {open && renderBooks(f.id)}
              </li>
            )
          })}

          <li className="fb-item" style={{ display: 'block' }}>
            <button
              type="button"
              className="btn btn-ghost"
              aria-expanded={openKey === 'none'}
              onClick={() => toggle('none')}
              style={{ width: '100%', justifyContent: 'flex-start' }}
            >
              {openKey === 'none' ? '▾' : '▸'} 폴더 없음 ({booksIn('none').length})
            </button>
            {openKey === 'none' && renderBooks('none')}
          </li>
        </ul>

        {folders.length === 0 && (
          <p style={{ fontSize: 13, color: '#777', marginTop: 12 }}>
            아직 폴더가 없어요. 위에서 첫 폴더를 만들어 보세요. <Link href="/dashboard">홈으로</Link>
          </p>
        )}
      </section>
    </main>
  )
}
