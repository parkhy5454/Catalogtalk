'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'

const FOLDER_NAME_MAX = 30

type Folder = { id: string; name: string }

function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : (err as { message?: string })?.message ?? String(err)
  if (/row-level security|policy/i.test(msg)) return '권한이 없어요. 다시 로그인해 주세요.'
  return msg
}

export default function FoldersPage() {
  const supabase = createClient()
  const [userId, setUserId] = useState<string | null>(null)
  const [folders, setFolders] = useState<Folder[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [unfiled, setUnfiled] = useState(0)
  const [newName, setNewName] = useState('')
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)

  const load = useCallback(
    async (uid: string) => {
      const [fRes, bRes] = await Promise.all([
        supabase.from('folders').select('id, name').eq('user_id', uid).order('created_at', { ascending: true }),
        supabase.from('flipbooks').select('folder_id').eq('user_id', uid),
      ])
      if (fRes.error) return setMessage({ kind: 'error', text: friendlyError(fRes.error) })
      setFolders((fRes.data as Folder[]) ?? [])
      const c: Record<string, number> = {}
      let none = 0
      for (const row of (bRes.data as { folder_id: string | null }[]) ?? []) {
        if (row.folder_id) c[row.folder_id] = (c[row.folder_id] ?? 0) + 1
        else none++
      }
      setCounts(c)
      setUnfiled(none)
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
    setCounts((prev) => ({ ...prev, [(data as Folder).id]: 0 }))
    setNewName('')
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
    await load(userId)
  }

  return (
    <main className="container section">
      <section className="panel" aria-labelledby="folders-title">
        <div className="panel-head">
          <h1 className="panel-title" id="folders-title">폴더</h1>
        </div>
        <p style={{ fontSize: 14, color: '#555', margin: '0 0 14px' }}>
          플립북을 주제별로 나눠 관리해요. 플립북을 옮기려면 홈 목록의 &quot;폴더 이동&quot;을 이용해 주세요.
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
          {folders.map((f) => (
            <li key={f.id} className="fb-item" style={{ alignItems: 'center' }}>
              <div className="fb-body">
                <div className="fb-title truncate" title={f.name}>📁 {f.name}</div>
                <div className="fb-meta">
                  <span className="chip">플립북 {counts[f.id] ?? 0}개</span>
                </div>
              </div>
              <div className="fb-actions-row">
                <button type="button" className="btn btn-ghost" onClick={() => handleRename(f)}>이름 변경</button>
                <button type="button" className="btn btn-danger" onClick={() => handleDelete(f)}>삭제</button>
              </div>
            </li>
          ))}
          <li className="fb-item" style={{ alignItems: 'center' }}>
            <div className="fb-body">
              <div className="fb-title">폴더 없음</div>
              <div className="fb-meta">
                <span className="chip">플립북 {unfiled}개</span>
              </div>
            </div>
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
