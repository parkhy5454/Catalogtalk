'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { createFlipbook, MAX_PDF_BYTES, sourceKindOf } from '@/lib/flipbook/upload'

const PLAN_LIMITS: Record<string, number | null> = { free: 3, starter: 20, pro: null, team: null }

// Load converters only when needed.
async function renderPdf(buf: ArrayBuffer, onPage: (d: number, t: number) => void) {
  const mod = await import('@/lib/flipbook/convert')
  return mod.renderPdfPages(buf, onPage)
}

async function renderDocx(buf: ArrayBuffer, onPage: (d: number, t: number) => void) {
  const mod = await import('@/lib/flipbook/docx')
  return mod.renderDocxPages(buf, onPage)
}

function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : (err as { message?: string })?.message ?? String(err)
  const plan = msg.match(/PLAN_LIMIT:\s*(.*)/)
  if (plan) return plan[1]
  // Show the real message (which step and which rule) until the upload issue is resolved.
  if (/row-level security|policy/i.test(msg)) return `권한 오류: ${msg}`
  return msg
}

// Upload screen opened by the centre "+" tab.
export default function NewFlipbookPage() {
  const router = useRouter()
  const supabase = createClient()
  const fileInput = useRef<HTMLInputElement>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [folders, setFolders] = useState<{ id: string; name: string }[]>([])
  const [uploadFolder, setUploadFolder] = useState('')
  const [title, setTitle] = useState('')
  const [count, setCount] = useState(0)
  const [limit, setLimit] = useState<number | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [progress, setProgress] = useState(0)
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => {
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      setUserId(user.id)
      const [cust, books, fo, team] = await Promise.all([
        supabase.from('customers').select('plan, bonus_flipbooks').eq('user_id', user.id).maybeSingle(),
        supabase.from('flipbooks').select('id').eq('user_id', user.id),
        supabase.from('folders').select('id, name').eq('user_id', user.id).order('created_at', { ascending: true }),
        supabase.rpc('get_my_team'),
      ])
      const myTeam = ((team.data as { catalog_count: number }[] | null) ?? [])[0]
      if (myTeam) {
        // Team members share one pool of catalog slots (enforced by the database too).
        setLimit(200)
        setCount(myTeam.catalog_count)
      } else {
        const plan = cust.data?.plan ?? 'free'
        const bonus = cust.data?.bonus_flipbooks ?? 0
        const base = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free
        setLimit(base === null ? null : base + bonus)
        setCount((books.data ?? []).length)
      }
      setFolders((fo.data as { id: string; name: string }[]) ?? [])
      setLoaded(true)
    })()
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
      setCount((c) => c + 1)
      setMessage({ kind: 'success', text: `"${fb.title}" 업로드 완료!` })
      router.push('/dashboard')
    } catch (err) {
      setMessage({ kind: 'error', text: friendlyError(err) })
    } finally {
      setBusy(false)
      setStatus('')
      setProgress(0)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const atLimit = limit !== null && count >= limit

  return (
    <main className="container section">
      <section className="panel" aria-labelledby="create-title">
        <div className="panel-head">
          <h1 className="panel-title" id="create-title">새 플립북 만들기</h1>
          <span className="pill">PDF · Word → 링크 3초</span>
        </div>

        {!loaded ? (
          <div className="skeleton" style={{ height: 180 }} aria-hidden="true" />
        ) : atLimit ? (
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
                <span className="field-label">저장할 폴더 (파일을 고르기 전에 선택해 주세요)</span>
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
                  <div className="dropzone-text">PDF 또는 Word(.docx) 업로드</div>
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
    </main>
  )
}
