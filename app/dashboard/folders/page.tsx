'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { copyText } from '@/lib/clipboard'
import {
  convertExisting,
  deleteFlipbook,
  type FlipbookRow,
} from '@/lib/flipbook/upload'


const FOLDER_FILTER_ALL = 'all'
const FOLDER_FILTER_NONE = 'none'

type Folder = { id: string; name: string }

// Load converters only when needed (keeps the dashboard light, and avoids SSR issues).
async function renderPdf(buf: ArrayBuffer, onPage: (d: number, t: number) => void) {
  const mod = await import('@/lib/flipbook/convert')
  return mod.renderPdfPages(buf, onPage)
}

async function renderDocx(buf: ArrayBuffer, onPage: (d: number, t: number) => void) {
  const mod = await import('@/lib/flipbook/docx')
  return mod.renderDocxPages(buf, onPage)
}

// The stored original decides the converter (.docx originals keep their extension in storage).
function rendererForUrl(url: string | null) {
  return /\.docx(\?|$)/i.test(url ?? '') ? renderDocx : renderPdf
}

function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : (err as { message?: string })?.message ?? String(err)
  // DB trigger error: "PLAN_LIMIT: ..." -> show only the human part.
  const plan = msg.match(/PLAN_LIMIT:\s*(.*)/)
  if (plan) return plan[1]
  if (/row-level security|policy/i.test(msg)) return '권한이 없어요. 다시 로그인해 주세요.'
  return msg
}

function shareText(title: string) {
  return `[카탈로그톡] ${title}`
}

export default function MyBookPage() {
  const router = useRouter()
  const supabase = createClient()
  const [userId, setUserId] = useState<string | null>(null)
  const [origin, setOrigin] = useState<string>('')
  const [canNativeShare, setCanNativeShare] = useState(false)
  const [plan, setPlan] = useState<string>('free')
  const [bonus, setBonus] = useState<number>(0)
  const [flipbooks, setFlipbooks] = useState<FlipbookRow[]>([])
  const [folders, setFolders] = useState<Folder[]>([])
  const [folderFilter, setFolderFilter] = useState<string>(FOLDER_FILTER_ALL)
  const [newFolderName, setNewFolderName] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [progress, setProgress] = useState(0)
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const [convertingId, setConvertingId] = useState<string | null>(null)
  const [shareOpenId, setShareOpenId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [pull, setPull] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  // Latest reload function, read by the touch listeners below (they are registered once).
  const reloadRef = useRef<() => Promise<void>>(async () => {})
  reloadRef.current = async () => {
    if (!userId) return
    await Promise.all([fetchFlipbooks(userId), fetchFolders(userId)])
  }

  const fetchFlipbooks = useCallback(
    async (uid: string) => {
      const { data, error } = await supabase
        .from('flipbooks')
        .select('id, title, slug, pdf_url, thumb_url, page_count, views, created_at, folder_id')
        .eq('user_id', uid)
        .order('created_at', { ascending: false })
      if (error) setMessage({ kind: 'error', text: friendlyError(error) })
      else setFlipbooks((data as FlipbookRow[]) ?? [])
    },
    [supabase]
  )

  const fetchFolders = useCallback(
    async (uid: string) => {
      const { data, error } = await supabase
        .from('folders')
        .select('id, name')
        .eq('user_id', uid)
        .order('created_at', { ascending: true })
      if (error) setMessage({ kind: 'error', text: friendlyError(error) })
      else setFolders((data as Folder[]) ?? [])
    },
    [supabase]
  )

  // Pull to refresh: drag down from the top of the page, release past the threshold.
  useEffect(() => {
    const TRIGGER = 64
    let startY = 0
    let active = false
    let last = 0
    const onStart = (e: TouchEvent) => {
      active = window.scrollY <= 0
      startY = e.touches[0].clientY
      last = 0
    }
    const onMove = (e: TouchEvent) => {
      if (!active) return
      const d = e.touches[0].clientY - startY
      if (d <= 0) {
        active = false
        setPull(0)
        return
      }
      last = Math.min(d * 0.5, 96)
      setPull(last)
    }
    const onEnd = async () => {
      if (!active) return
      active = false
      if (last < TRIGGER) {
        setPull(0)
        return
      }
      setPull(0)
      setRefreshing(true)
      try {
        navigator.vibrate?.(10)
      } catch {
        // haptics optional
      }
      await reloadRef.current()
      setRefreshing(false)
    }
    window.addEventListener('touchstart', onStart, { passive: true })
    window.addEventListener('touchmove', onMove, { passive: true })
    window.addEventListener('touchend', onEnd)
    return () => {
      window.removeEventListener('touchstart', onStart)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
    }
  }, [])

  useEffect(() => {
    setOrigin(window.location.origin)
    setCanNativeShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function')
    let cancelled = false
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        router.replace('/login')
        return
      }
      if (cancelled) return
      setUserId(user.id)
      const { data: customer } = await supabase
        .from('customers')
        .select('plan, bonus_flipbooks')
        .eq('user_id', user.id)
        .maybeSingle()
      if (customer?.plan) setPlan(customer.plan)
      setBonus(customer?.bonus_flipbooks ?? 0)
      await Promise.all([fetchFlipbooks(user.id), fetchFolders(user.id)])
      setLoaded(true)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleConvert = async (fb: FlipbookRow) => {
    if (busy || !userId) return
    setBusy(true)
    setConvertingId(fb.id)
    setMessage(null)
    try {
      await convertExisting(supabase, fb, rendererForUrl(fb.pdf_url), (text, p) => {
        setStatus(text)
        setProgress(Math.round(p * 100))
      })
      await fetchFlipbooks(userId)
      setMessage({ kind: 'success', text: `"${fb.title}" 모바일 뷰어 변환 완료` })
    } catch (err) {
      setMessage({ kind: 'error', text: friendlyError(err) })
    } finally {
      setBusy(false)
      setConvertingId(null)
      setStatus('')
      setProgress(0)
    }
  }

  const handleDelete = async (fb: FlipbookRow) => {
    const ok = window.confirm(
      `"${fb.title}"을(를) 삭제할까요?\n삭제하면 링크(/b/${fb.slug})가 더 이상 열리지 않아요.`
    )
    if (!ok || !userId) return
    setMessage(null)
    try {
      await deleteFlipbook(supabase, fb)
      await fetchFlipbooks(userId)
      setMessage({ kind: 'success', text: `"${fb.title}"을(를) 삭제했어요` })
    } catch (err) {
      setMessage({ kind: 'error', text: friendlyError(err) })
    }
  }

  const handleCopy = async (slug: string) => {
    const ok = await copyText(`${origin}/b/${slug}`)
    setMessage(ok ? { kind: 'success', text: '✅ 링크를 복사했어요' } : { kind: 'error', text: '복사하지 못했어요. 링크를 길게 눌러 직접 복사해 주세요.' })
  }

  const handleNativeShare = async (fb: FlipbookRow) => {
    try {
      await navigator.share({ title: fb.title, text: shareText(fb.title), url: `${origin}/b/${fb.slug}` })
      setShareOpenId(null)
    } catch (err) {
      // Cancelling the share sheet is not an error worth showing.
      if ((err as Error).name !== 'AbortError') setMessage({ kind: 'error', text: '공유하지 못했어요. 링크 복사를 이용해 주세요.' })
    }
  }

  const handleMoveFlipbook = async (fb: FlipbookRow, folderId: string) => {
    const nextId = folderId || null
    const { error } = await supabase.from('flipbooks').update({ folder_id: nextId }).eq('id', fb.id)
    if (error) {
      setMessage({ kind: 'error', text: friendlyError(error) })
      return
    }
    setFlipbooks((prev) => prev.map((f) => (f.id === fb.id ? { ...f, folder_id: nextId } : f)))
  }

  const shareTarget = flipbooks.find((f) => f.id === shareOpenId) ?? null
  const selectedFolder = folders.find((f) => f.id === folderFilter) ?? null

  const handleCreateFolder = async () => {
    const name = newFolderName.trim().slice(0, 30)
    if (!name || !userId) return
    setMessage(null)
    const { data, error } = await supabase.from('folders').insert({ user_id: userId, name }).select('id, name').single()
    if (error) return setMessage({ kind: 'error', text: friendlyError(error) })
    setFolders((prev) => [...prev, data as Folder])
    setNewFolderName('')
    setFolderFilter((data as Folder).id)
  }

  const handleRenameFolder = async (folder: Folder) => {
    const next = window.prompt('새 폴더 이름', folder.name)?.trim().slice(0, 30)
    if (!next || next === folder.name) return
    const { error } = await supabase.from('folders').update({ name: next }).eq('id', folder.id)
    if (error) return setMessage({ kind: 'error', text: friendlyError(error) })
    setFolders((prev) => prev.map((f) => (f.id === folder.id ? { ...f, name: next } : f)))
  }

  const handleDeleteFolder = async (folder: Folder) => {
    const ok = window.confirm(`"${folder.name}" 폴더를 삭제할까요?\n안의 플립북은 삭제되지 않고 '폴더 없음'으로 옮겨져요.`)
    if (!ok) return
    const { error } = await supabase.from('folders').delete().eq('id', folder.id)
    if (error) return setMessage({ kind: 'error', text: friendlyError(error) })
    setFolders((prev) => prev.filter((f) => f.id !== folder.id))
    setFlipbooks((prev) => prev.map((fb) => (fb.folder_id === folder.id ? { ...fb, folder_id: null } : fb)))
    setFolderFilter(FOLDER_FILTER_ALL)
  }

  const visibleFlipbooks = flipbooks.filter((fb) =>
    folderFilter === FOLDER_FILTER_ALL
      ? true
      : folderFilter === FOLDER_FILTER_NONE
        ? !fb.folder_id
        : fb.folder_id === folderFilter
  )
  const folderNameById = (id: string | null) => folders.find((f) => f.id === id)?.name ?? ''
  const selectedFolderName = folders.find((f) => f.id === folderFilter)?.name ?? ''

  const totalViews = flipbooks.reduce((s, f) => s + (f.views || 0), 0)
  return (
    <main className="container section">
      <h1 className="panel-title" style={{ margin: '4px 4px 14px', fontSize: 22 }}>My Book</h1>

      {(pull > 0 || refreshing) && (
        <div className="ptr" style={{ height: refreshing ? 44 : pull }} role="status">
          {refreshing ? '새로고침 중...' : pull >= 64 ? '놓으면 새로고침' : '당겨서 새로고침'}
        </div>
      )}

      <section className="panel" aria-labelledby="folder-mgmt-title">
        <div className="panel-head">
          <h2 className="panel-title" id="folder-mgmt-title">폴더</h2>
        </div>
        <div className="fb-actions-row">
          <input
            className="input"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            placeholder="새 폴더 이름"
            maxLength={30}
            aria-label="새 폴더 이름"
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateFolder()
            }}
          />
          <button type="button" className="btn btn-primary" onClick={handleCreateFolder} disabled={!newFolderName.trim()}>
            폴더 추가
          </button>
        </div>
        {selectedFolder && (
          <div className="fb-actions-row" style={{ marginTop: 10 }}>
            <button type="button" className="btn btn-ghost" onClick={() => handleRenameFolder(selectedFolder)}>이름 변경</button>
            <button type="button" className="btn btn-danger" onClick={() => handleDeleteFolder(selectedFolder)}>폴더 삭제</button>
          </div>
        )}
      </section>

      <section className="panel" aria-labelledby="list-title">
        <div className="panel-head">
          <h2 className="panel-title" id="list-title">
            {folderFilter === FOLDER_FILTER_ALL
              ? `내 플립북 (${flipbooks.length})`
              : `${folderFilter === FOLDER_FILTER_NONE ? '폴더 없음' : selectedFolderName} (${visibleFlipbooks.length})`}
          </h2>
        </div>

        {folders.length > 0 && (
          <div className="fb-actions-row" style={{ flexWrap: 'wrap', marginBottom: 12 }} aria-label="폴더 필터">
            <button
              type="button"
              className="btn btn-ghost"
              aria-pressed={folderFilter === FOLDER_FILTER_ALL}
              onClick={() => setFolderFilter(FOLDER_FILTER_ALL)}
            >
              전체
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              aria-pressed={folderFilter === FOLDER_FILTER_NONE}
              onClick={() => setFolderFilter(FOLDER_FILTER_NONE)}
            >
              폴더 없음
            </button>
            {folders.map((f) => (
              <button
                key={f.id}
                type="button"
                className="btn btn-ghost"
                aria-pressed={folderFilter === f.id}
                onClick={() => setFolderFilter(f.id)}
              >
                {f.name}
              </button>
            ))}
          </div>
        )}

        {!loaded ? (
          <ul className="fb-list" aria-label="불러오는 중">
            {[0, 1, 2].map((i) => (
              <li key={i} className="fb-item" aria-hidden="true">
                <div className="skeleton skel-thumb" />
                <div className="fb-body">
                  <div className="skeleton skel-line" />
                  <div className="skeleton skel-line short" />
                </div>
              </li>
            ))}
          </ul>
        ) : flipbooks.length === 0 ? (
          <div className="empty">
            <div className="empty-icon" aria-hidden="true">📚</div>
            <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--ink)' }}>아직 만든 플립북이 없어요</div>
            <div style={{ fontSize: 13 }}>위에서 PDF나 Word 문서를 올리면 카톡 링크가 바로 생겨요!</div>
          </div>
        ) : visibleFlipbooks.length === 0 ? (
          <div className="empty">
            <div style={{ fontSize: 13 }}>이 폴더에 플립북이 없어요. 아래 폴더 이동으로 옮겨 보세요.</div>
          </div>
        ) : (
          <ul className="fb-list">
            {visibleFlipbooks.map((fb) => {
              const needsConvert = !fb.page_count
              const text = shareText(fb.title)
              const shareUrl = `${origin}/b/${fb.slug}`
              return (
                <li key={fb.id} className="fb-item">
                  {fb.thumb_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="fb-thumb" src={fb.thumb_url} alt="" loading="lazy" decoding="async" />
                  ) : (
                    <div className="fb-thumb" aria-hidden="true" />
                  )}
                  <div className="fb-body">
                    <div className="fb-title truncate" title={fb.title}>{fb.title}</div>
                    <div className="fb-meta">
                      <span className="truncate" style={{ maxWidth: '100%' }}>/b/{fb.slug}</span>
                      <span className="chip">조회 {fb.views || 0}회</span>
                      {fb.page_count ? <span className="chip">{fb.page_count}쪽</span> : null}
                      {folderNameById(fb.folder_id) && <span className="chip">📁 {folderNameById(fb.folder_id)}</span>}
                      <span>{new Date(fb.created_at).toLocaleDateString('ko-KR')}</span>
                    </div>
                    {folders.length > 0 && (
                      <label className="field" style={{ marginTop: 10 }}>
                        <span className="field-label">폴더 이동</span>
                        <select
                          className="input"
                          value={fb.folder_id ?? ''}
                          onChange={(e) => handleMoveFlipbook(fb, e.target.value)}
                        >
                          <option value="">폴더 없음</option>
                          {folders.map((f) => (
                            <option key={f.id} value={f.id}>{f.name}</option>
                          ))}
                        </select>
                      </label>
                    )}
                    {needsConvert && (
                      <div className="notice notice-info" style={{ marginTop: 10, padding: '8px 10px', fontSize: 12 }}>
                        모바일 뷰어용 이미지가 아직 없어요. &quot;뷰어 변환&quot;을 눌러 주세요.
                      </div>
                    )}
                    {convertingId === fb.id && (
                      <div className="progress" style={{ marginTop: 10 }} aria-hidden="true">
                        <span style={{ width: `${progress}%` }} />
                      </div>
                    )}
                  </div>
                  <div className="fb-actions">
                    {needsConvert ? (
                      <button type="button" className="btn btn-kakao" onClick={() => handleConvert(fb)} disabled={busy}>
                        뷰어 변환
                      </button>
                    ) : (
                      <a className="btn btn-primary" href={`/b/${fb.slug}`} target="_blank" rel="noopener">
                        보기
                      </a>
                    )}
                    <div className="fb-actions-row">
                      <button type="button" className="btn btn-ghost" onClick={() => handleCopy(fb.slug)}>
                        링크 복사
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        aria-expanded={shareOpenId === fb.id}
                        onClick={() => setShareOpenId(shareOpenId === fb.id ? null : fb.id)}
                      >
                        보내기
                      </button>
                      <button type="button" className="btn btn-danger" onClick={() => handleDelete(fb)} disabled={busy}>
                        삭제
                      </button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {shareTarget && (
        <>
          <div className="sheet-backdrop" onClick={() => setShareOpenId(null)} aria-hidden="true" />
          <div className="sheet" role="dialog" aria-modal="true" aria-label="보내기">
            <div className="sheet-grip" aria-hidden="true" />
            <div className="sheet-title">{shareTarget.title}</div>
            {canNativeShare && (
              <button type="button" className="sheet-action" onClick={() => handleNativeShare(shareTarget)}>
                <span className="sheet-icon" aria-hidden="true">📤</span>공유하기
              </button>
            )}
            <a className="sheet-action" href={`sms:?body=${encodeURIComponent(`${shareText(shareTarget.title)}\n${origin}/b/${shareTarget.slug}`)}`}>
              <span className="sheet-icon" aria-hidden="true">💬</span>문자로 보내기
            </a>
            <a
              className="sheet-action"
              href={`mailto:?subject=${encodeURIComponent(`[카탈로그톡] ${shareTarget.title}`)}&body=${encodeURIComponent(`${shareText(shareTarget.title)}\n${origin}/b/${shareTarget.slug}`)}`}
            >
              <span className="sheet-icon" aria-hidden="true">✉️</span>이메일로 보내기
            </a>
            <button
              type="button"
              className="sheet-action"
              onClick={async () => {
                await handleCopy(shareTarget.slug)
                setShareOpenId(null)
              }}
            >
              <span className="sheet-icon" aria-hidden="true">🔗</span>링크 복사
            </button>
            <button type="button" className="sheet-action sheet-cancel" onClick={() => setShareOpenId(null)}>
              닫기
            </button>
          </div>
        </>
      )}
    </main>
  )
}
