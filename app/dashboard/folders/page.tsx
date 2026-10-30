'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { copyText } from '@/lib/clipboard'
import { KAKAO_JS_KEY, shareCatalogToKakao } from '@/lib/kakao'
import {
  convertExisting,
  migrateToPrivate,
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

function needsConvertOf(fb: { page_count: number }) {
  return !fb.page_count
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
        .select('id, title, slug, pdf_url, thumb_url, page_count, views, created_at, folder_id, is_public, password_hash, expires_at')
        .eq('user_id', uid)
        .order('created_at', { ascending: false })
      if (error) setMessage({ kind: 'error', text: friendlyError(error) })
      else {
        // Keep only a yes/no flag in the UI state; the hash stays out of React state.
        const rows = (data ?? []) as (FlipbookRow & { password_hash: string | null })[]
        setFlipbooks(rows.map(({ password_hash, ...rest }) => ({ ...rest, has_password: !!password_hash })))
      }
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

  // Swipe left on a card to reveal 삭제 (the delete still asks for confirmation).
  const SWIPE_OPEN = -88
  const [swipeOpenId, setSwipeOpenId] = useState<string | null>(null)
  const [swipeDrag, setSwipeDrag] = useState<{ id: string; dx: number } | null>(null)
  const swipeTouch = useRef<{ id: string; x: number; y: number; locked: boolean } | null>(null)
  const swipeOffset = (id: string) =>
    swipeDrag?.id === id ? swipeDrag.dx : swipeOpenId === id ? SWIPE_OPEN : 0
  const onSwipeStart = (id: string, e: React.TouchEvent) => {
    swipeTouch.current = { id, x: e.touches[0].clientX, y: e.touches[0].clientY, locked: false }
  }
  const onSwipeMove = (e: React.TouchEvent) => {
    const t = swipeTouch.current
    if (!t) return
    const dx = e.touches[0].clientX - t.x
    const dy = e.touches[0].clientY - t.y
    if (!t.locked) {
      // Vertical movement is a normal scroll: stop tracking the swipe.
      if (Math.abs(dy) > Math.abs(dx)) {
        swipeTouch.current = null
        return
      }
      if (Math.abs(dx) < 8) return
      t.locked = true
    }
    const base = swipeOpenId === t.id ? SWIPE_OPEN : 0
    setSwipeDrag({ id: t.id, dx: Math.max(-96, Math.min(0, base + dx)) })
  }
  const onSwipeEnd = () => {
    const t = swipeTouch.current
    swipeTouch.current = null
    if (t && swipeDrag && swipeDrag.id === t.id) {
      setSwipeOpenId(swipeDrag.dx < -48 ? t.id : null)
    }
    setSwipeDrag(null)
  }

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
      // Ignore small finger movements so the list does not twitch while scrolling.
      if (d < 12) return
      last = Math.min((d - 12) * 0.5, 96)
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

  const handleMigrate = async (fb: FlipbookRow) => {
    if (busy || !userId) return
    const ok = window.confirm(
      `"${fb.title}"을(를) 비공개 저장소로 옮길까요?\n링크와 보기 화면은 그대로 유지돼요. 옮기는 동안 시간이 조금 걸려요.`
    )
    if (!ok) return
    setBusy(true)
    setConvertingId(fb.id)
    setMessage(null)
    try {
      await migrateToPrivate(supabase, fb, rendererForUrl(fb.pdf_url), (text, p) => {
        setStatus(text)
        setProgress(Math.round(p * 100))
      })
      await fetchFlipbooks(userId)
      setMessage({ kind: 'success', text: `"${fb.title}" 비공개 저장소로 옮겼어요` })
    } catch (err) {
      setMessage({ kind: 'error', text: friendlyError(err) })
    } finally {
      setBusy(false)
      setConvertingId(null)
      setStatus('')
      setProgress(0)
    }
  }

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

  // Switch the public link on/off. While off, the viewer link shows "not found".
  const toggleShare = async (fb: FlipbookRow) => {
    const next = !fb.is_public
    if (!next) {
      const ok = window.confirm(`"${fb.title}" 링크를 끌까요?\n끄면 받은 사람이 더 이상 볼 수 없어요.`)
      if (!ok) return
    }
    setMessage(null)
    const { error } = await supabase.from('flipbooks').update({ is_public: next }).eq('id', fb.id)
    if (error) {
      setMessage({ kind: 'error', text: friendlyError(error) })
      return
    }
    setFlipbooks((prev) => prev.map((f) => (f.id === fb.id ? { ...f, is_public: next } : f)))
    setMessage({ kind: 'success', text: next ? '링크를 다시 열었어요' : '링크를 껐어요' })
  }

  const handleExpiry = async (fb: FlipbookRow) => {
    setMessage(null)
    const hint = fb.expires_at ? `현재 만료일: ${fb.expires_at.slice(0, 10)}\n` : ''
    const input = window.prompt(`${hint}링크 만료일을 입력해 주세요 (예: 2026-12-31)\n비워 두면 기간 없음으로 바뀌어요.`, fb.expires_at ? fb.expires_at.slice(0, 10) : '')
    if (input === null) return
    const trimmed = input.trim()
    let next: string | null = null
    if (trimmed !== '') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed) || Number.isNaN(Date.parse(trimmed))) {
        setMessage({ kind: 'error', text: '날짜는 2026-12-31 형식으로 입력해 주세요' })
        return
      }
      // End of that day in Korea time.
      next = `${trimmed}T23:59:59+09:00`
      if (new Date(next).getTime() <= Date.now()) {
        setMessage({ kind: 'error', text: '오늘 이후 날짜로 입력해 주세요' })
        return
      }
    }
    const { error } = await supabase.from('flipbooks').update({ expires_at: next }).eq('id', fb.id)
    if (error) {
      setMessage({ kind: 'error', text: friendlyError(error) })
      return
    }
    setFlipbooks((prev) => prev.map((f) => (f.id === fb.id ? { ...f, expires_at: next } : f)))
    setMessage({ kind: 'success', text: next ? `${trimmed}까지 열려 있어요` : '기간 없음으로 바꿨어요' })
  }

  const handlePassword = async (fb: FlipbookRow) => {
    setMessage(null)
    let next: string | null = null
    if (fb.has_password) {
      const ok = window.confirm(`"${fb.title}" 비밀번호를 해제할까요?\n해제하면 링크만 있으면 누구나 볼 수 있어요.`)
      if (!ok) return
    } else {
      const input = window.prompt('받는 사람이 입력할 비밀번호를 정해 주세요 (4~30자)')
      if (input === null) return
      if (input.trim().length < 4 || input.length > 30) {
        setMessage({ kind: 'error', text: '비밀번호는 4~30자로 입력해 주세요' })
        return
      }
      next = input
    }
    const res = await fetch(`/api/flipbook/${encodeURIComponent(fb.slug)}/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: next }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setMessage({ kind: 'error', text: body.error ?? '비밀번호를 바꾸지 못했어요' })
      return
    }
    setFlipbooks((prev) => prev.map((f) => (f.id === fb.id ? { ...f, has_password: next !== null } : f)))
    setMessage({ kind: 'success', text: next !== null ? '비밀번호를 설정했어요' : '비밀번호를 해제했어요' })
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
    const ok = await copyText(`${origin}/b/${slug}?src=link`)
    setMessage(ok ? { kind: 'success', text: '✅ 링크를 복사했어요' } : { kind: 'error', text: '복사하지 못했어요. 링크를 길게 눌러 직접 복사해 주세요.' })
  }

  const handleNativeShare = async (fb: FlipbookRow) => {
    try {
      await navigator.share({ title: fb.title, text: shareText(fb.title), url: `${origin}/b/${fb.slug}?src=native` })
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
        <div className="ptr ptr-fixed" style={{ height: refreshing ? 44 : pull }} role="status">
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
          <div className="filter-row" style={{ marginBottom: 12 }} aria-label="폴더 필터">
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
                <li key={fb.id} className="fb-swipe-row">
                  <button
                    type="button"
                    className="fb-swipe-delete"
                    onClick={() => {
                      setSwipeOpenId(null)
                      handleDelete(fb)
                    }}
                    disabled={busy}
                    aria-label={`${fb.title} 삭제`}
                  >
                    삭제
                  </button>
                  <div
                    className="fb-item"
                    style={{
                      transform: `translateX(${swipeOffset(fb.id)}px)`,
                      transition: swipeDrag ? 'none' : 'transform 0.2s ease',
                      background: '#fff',
                    }}
                    onTouchStart={(e) => onSwipeStart(fb.id, e)}
                    onTouchMove={onSwipeMove}
                    onTouchEnd={onSwipeEnd}
                    onClickCapture={(e) => {
                      // While the delete button is showing, a tap on the card only closes it.
                      if (swipeOpenId === fb.id) {
                        e.preventDefault()
                        e.stopPropagation()
                        setSwipeOpenId(null)
                      }
                    }}
                  >
                  {fb.thumb_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="fb-thumb" src={fb.thumb_url} alt="" loading="lazy" decoding="async" />
                  ) : (
                    <div className="fb-thumb" aria-hidden="true" />
                  )}
                  <div className="fb-body">
                    <div className="fb-title truncate" title={fb.title}>
                      {fb.title}
                      {!fb.is_public && <span className="pill" style={{ marginLeft: 6 }}>링크 꺼짐</span>}
                      {fb.has_password && <span className="pill" style={{ marginLeft: 6 }}>비밀번호</span>}
                      {fb.expires_at && <span className="pill" style={{ marginLeft: 6 }}>{new Date(fb.expires_at).getTime() <= Date.now() ? '기간 만료' : `~${fb.expires_at.slice(0, 10)}`}</span>}
                    </div>
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
                      <a className="btn btn-primary" href={`/b/${fb.slug}`}>
                        보기
                      </a>
                    )}
                    <div className="fb-actions-row fb-card-actions">
                      <button type="button" className="btn btn-ghost" onClick={() => toggleShare(fb)}>
                        {fb.is_public ? '링크 끄기' : '링크 켜기'}
                      </button>
                      {!needsConvertOf(fb) && fb.pdf_url && !fb.pdf_url.startsWith('private:') && (
                        <button type="button" className="btn btn-ghost" onClick={() => handleMigrate(fb)} disabled={busy}>
                          비공개로 옮기기
                        </button>
                      )}
                      <button type="button" className="btn btn-ghost" onClick={() => handleExpiry(fb)}>
                        만료일
                      </button>
                      <button type="button" className="btn btn-ghost" onClick={() => handlePassword(fb)}>
                        {fb.has_password ? '비밀번호 해제' : '비밀번호 설정'}
                      </button>
                      <button type="button" className="btn btn-ghost" onClick={() => router.push(`/dashboard/stats/${fb.id}`)}>
                        통계
                      </button>
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
            {KAKAO_JS_KEY && shareTarget.thumb_url && (
              <button
                type="button"
                className="sheet-action"
                onClick={async () => {
                  try {
                    await shareCatalogToKakao({
                      title: shareTarget.title,
                      imageUrl: shareTarget.thumb_url as string,
                      link: `${origin}/b/${shareTarget.slug}?src=kakao`,
                    })
                    setShareOpenId(null)
                  } catch (err) {
                    setMessage({ kind: 'error', text: err instanceof Error ? err.message : '카카오톡으로 보내지 못했어요' })
                  }
                }}
              >
                <span className="sheet-icon" aria-hidden="true">💛</span>카카오톡으로 보내기
              </button>
            )}
            {canNativeShare && (
              <button type="button" className="sheet-action" onClick={() => handleNativeShare(shareTarget)}>
                <span className="sheet-icon" aria-hidden="true">📤</span>공유하기
              </button>
            )}
            <a className="sheet-action" href={`sms:?body=${encodeURIComponent(`${shareText(shareTarget.title)}\n${origin}/b/${shareTarget.slug}?src=sms`)}`}>
              <span className="sheet-icon" aria-hidden="true">💬</span>문자로 보내기
            </a>
            <a
              className="sheet-action"
              href={`mailto:?subject=${encodeURIComponent(`[카탈로그톡] ${shareTarget.title}`)}&body=${encodeURIComponent(`${shareText(shareTarget.title)}\n${origin}/b/${shareTarget.slug}?src=mail`)}`}
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
