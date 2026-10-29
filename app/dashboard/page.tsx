'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { copyText } from '@/lib/clipboard'
import {
  convertExisting,
  createFlipbook,
  deleteFlipbook,
  type FlipbookRow,
  MAX_PDF_BYTES,
  sourceKindOf,
} from '@/lib/flipbook/upload'

const PLAN_LIMITS: Record<string, { label: string; limit: number | null }> = {
  free: { label: '무료 플랜 (기본 3개)', limit: 3 },
  starter: { label: 'Starter (기본 20개)', limit: 20 },
  pro: { label: 'Pro (무제한)', limit: null },
  team: { label: 'Team (무제한)', limit: null },
}

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

export default function DashboardPage() {
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
  const [uploadFolder, setUploadFolder] = useState<string>('')
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [progress, setProgress] = useState(0)
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [convertingId, setConvertingId] = useState<string | null>(null)
  const [shareOpenId, setShareOpenId] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

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
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleFile = async (file: File) => {
    setMessage(null)
    if (busy || !userId) return
    const kind = sourceKindOf(file.name)
    if (!kind) {
      setMessage({
        kind: 'error',
        text: /\.hwpx?$/i.test(file.name)
          ? '한글(HWP) 파일은 한글 프로그램에서 PDF로 저장한 뒤 올려 주세요'
          : 'PDF 또는 Word(.docx) 파일만 올릴 수 있어요',
      })
      return
    }
    if (file.size > MAX_PDF_BYTES) {
      setMessage({ kind: 'error', text: '50MB 이하 파일만 가능해요' })
      return
    }
    const name = title.trim() || file.name.replace(/\.(pdf|docx)$/i, '')
    setBusy(true)
    setProgress(0)
    try {
      const fb = await createFlipbook(
        supabase,
        { userId, title: name, file, folderId: uploadFolder || null },
        kind === 'docx' ? renderDocx : renderPdf,
        (text, p) => {
          setStatus(text)
          setProgress(Math.round(p * 100))
        }
      )
      setTitle('')
      await fetchFlipbooks(userId)
      setMessage({ kind: 'success', text: `업로드 완료! 링크: /b/${fb.slug}` })
    } catch (err) {
      setMessage({ kind: 'error', text: friendlyError(err) })
    } finally {
      setBusy(false)
      setStatus('')
      setProgress(0)
      if (fileInput.current) fileInput.current.value = ''
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
  const planInfo = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free
  // Referral bonuses add slots on top of the plan's base limit.
  const limit = planInfo.limit === null ? null : planInfo.limit + bonus
  const atLimit = limit !== null && flipbooks.length >= limit

  return (
    <main className="container section">
      <div className="stats" aria-label="요약">
        <div className="stat">
          <div className="stat-label">내 플립북</div>
          <div className="stat-value">{flipbooks.length}개</div>
        </div>
        <div className="stat">
          <div className="stat-label">총 조회수</div>
          <div className="stat-value">{totalViews.toLocaleString()}회</div>
        </div>
        <div className="stat stat-dark">
          <div className="stat-label">요금제</div>
          <div className="stat-value">
            {planInfo.label}
            {bonus > 0 ? ` + 추천 ${bonus}개` : ''}
          </div>
        </div>
      </div>

      <section className="panel" aria-labelledby="create-title">
        <div className="panel-head">
          <h2 className="panel-title" id="create-title">새 플립북 만들기</h2>
          <span className="pill">PDF · Word → 링크 3초</span>
        </div>

        {atLimit ? (
          <div className="notice notice-info">
            현재 플립북 개수({limit}개)를 모두 사용했어요. 요금제를 올리거나 친구를 추천하면 더 만들 수 있어요.
          </div>
        ) : (
          <div className="form-stack">
            <label className="field">
              <span className="field-label">카탈로그 제목 (비우면 파일 이름을 써요)</span>
              <input
                className="input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="예: 2024 쿨오토모빌 카탈로그"
                maxLength={100}
                disabled={busy}
              />
            </label>

            {folders.length > 0 && (
              <label className="field">
                <span className="field-label">저장할 폴더</span>
                <select
                  className="input"
                  value={uploadFolder}
                  onChange={(e) => setUploadFolder(e.target.value)}
                  disabled={busy}
                >
                  <option value="">폴더 없음</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
              </label>
            )}

            <div
              className={`dropzone${dragOver ? ' is-over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(true)
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDragOver(false)
                const f = e.dataTransfer.files[0]
                if (f && !busy) handleFile(f)
              }}
            >
              <div className="dropzone-icon" aria-hidden="true">{busy ? '⏳' : '📄'}</div>
              {busy ? (
                <>
                  <div className="dropzone-text" role="status">{status || '처리 중...'}</div>
                  <div className="progress" style={{ maxWidth: 320, width: '100%' }} aria-hidden="true">
                    <span style={{ width: `${progress}%` }} />
                  </div>
                </>
              ) : (
                <>
                  <div className="dropzone-text">PDF 또는 Word(.docx)를 여기에 끌어놓거나 아래 버튼을 누르세요</div>
                  <div className="dropzone-sub">최대 50MB · 한글(HWP)은 PDF로 저장해 올려 주세요</div>
                </>
              )}
              <label className={`btn btn-primary${busy ? ' btn-disabled' : ''}`} style={{ marginTop: 6 }}>
                파일 선택
                <input
                  ref={fileInput}
                  type="file"
                  accept="application/pdf,.pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) handleFile(f)
                  }}
                  disabled={busy}
                  className="sr-only"
                />
              </label>
            </div>
          </div>
        )}

        {message && (
          <div className={`notice ${message.kind === 'error' ? 'notice-error' : 'notice-success'}`} role="status" style={{ marginTop: 16 }}>
            {message.text}
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

        {flipbooks.length === 0 ? (
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
                    {shareOpenId === fb.id && (
                      <div className="fb-actions-row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
                        {canNativeShare && (
                          <button type="button" className="btn btn-primary" onClick={() => handleNativeShare(fb)}>
                            공유하기
                          </button>
                        )}
                        <a className="btn btn-ghost" href={`sms:?body=${encodeURIComponent(`${text}\n${shareUrl}`)}`}>
                          문자 보내기
                        </a>
                        <a
                          className="btn btn-ghost"
                          href={`mailto:?subject=${encodeURIComponent(`[카탈로그톡] ${fb.title}`)}&body=${encodeURIComponent(`${text}\n${shareUrl}`)}`}
                        >
                          이메일 보내기
                        </a>
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
    </main>
  )
}
