import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { removeReportedMessage, setReportStatus } from './actions'

export const dynamic = 'force-dynamic'

// Only operators (customers.is_admin = true, set in the database) may view this page.

type AuthUser = {
  id: string
  email?: string
  created_at: string
  last_sign_in_at?: string | null
  email_confirmed_at?: string | null
}

type ReportMessage = {
  body: string
  file_path: string | null
  file_name: string | null
  file_type: string | null
  catalog_title: string | null
  sender_id: string
}

type ReportRow = {
  id: string
  reason: string
  status: 'open' | 'resolved' | 'dismissed'
  created_at: string
  reporter_id: string
  message_id: string | null
  chat_messages: ReportMessage | ReportMessage[] | null
}

type CustomerRow = {
  user_id: string
  name: string | null
  phone: string | null
  company_name: string | null
  plan: string | null
  bonus_flipbooks: number | null
  referred_by: string | null
  is_admin: boolean | null
}

export default async function AdminPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  // Server-side gate: regular users are redirected, whatever the UI shows.
  // The operator flag lives in customers.is_admin; the row is readable by its owner under RLS.
  const { data: me } = await supabase.from('customers').select('is_admin').eq('user_id', user.id).maybeSingle()
  if (me?.is_admin !== true) redirect('/dashboard')

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const users: AuthUser[] = []
  const customers = new Map<string, CustomerRow>()
  const flipbookCounts = new Map<string, number>()
  let reports: ReportRow[] = []
  let error: string | null = null

  if (!serviceKey) {
    error = 'SUPABASE_SERVICE_ROLE_KEY 환경변수가 없어요. Vercel → Settings → Environment Variables에 추가해 주세요.'
  } else {
    const admin = createAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    // listUsers is paginated (default 50 per page): walk every page.
    for (let page = 1; page < 1000; page++) {
      const { data, error: listErr } = await admin.auth.admin.listUsers({ page, perPage: 200 })
      if (listErr) {
        error = listErr.message
        break
      }
      users.push(...(data.users as AuthUser[]))
      if (data.users.length < 200) break
    }

    const { data: rows, error: custErr } = await admin
      .from('customers')
      .select('user_id, name, phone, company_name, plan, bonus_flipbooks, referred_by, is_admin')
    if (custErr) error = error ?? custErr.message
    for (const r of (rows as CustomerRow[]) ?? []) customers.set(r.user_id, r)

    const { data: fbRows } = await admin.from('flipbooks').select('user_id')
    for (const r of (fbRows as { user_id: string }[]) ?? []) {
      flipbookCounts.set(r.user_id, (flipbookCounts.get(r.user_id) ?? 0) + 1)
    }

    const { data: reportRows } = await createServiceClient()
      .from('chat_reports')
      .select('id, reason, status, created_at, reporter_id, message_id, chat_messages(body, file_path, file_name, file_type, catalog_title, sender_id)')
      .order('status', { ascending: true })
      .order('created_at', { ascending: false })
      .limit(100)
    // Open reports first, then the rest in the order they arrived.
    reports = ((reportRows as unknown as ReportRow[]) ?? []).sort(
      (a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1)
    )
  }

  const fmt = (s?: string | null) => (s ? new Date(s).toLocaleString('ko-KR') : '-')
  const dash = (s?: string | null) => (s && s.trim() ? s : '-')

  return (
    <main className="container section">
        <div className="panel-head" style={{ marginBottom: 16 }}>
          <div>
            <h1 className="panel-title" style={{ fontSize: 22 }}>관리자 대시보드</h1>
            <p className="muted" style={{ fontSize: 14 }}>총 {users.length.toLocaleString()}명의 가입자</p>
          </div>
          <Link href="/dashboard/profile" className="btn btn-primary">← 내 정보</Link>
        </div>

        {error && <div className="notice notice-error" role="alert" style={{ marginBottom: 16 }}>에러: {error}</div>}

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">이메일</th>
                <th scope="col">이름</th>
                <th scope="col">휴대폰</th>
                <th scope="col">회사</th>
                <th scope="col">요금제</th>
                <th scope="col">플립북</th>
                <th scope="col">추천 보너스</th>
                <th scope="col">가입일</th>
                <th scope="col">최근 로그인</th>
                <th scope="col">인증</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const c = customers.get(u.id)
                return (
                  <tr key={u.id}>
                    <td style={{ fontWeight: 600 }}>
                      {u.email}
                      {customers.get(u.id)?.is_admin === true && <span className="badge-admin">ADMIN</span>}
                    </td>
                    <td>{dash(c?.name)}</td>
                    <td>{dash(c?.phone)}</td>
                    <td>{dash(c?.company_name)}</td>
                    <td>{c?.plan ?? 'free'}</td>
                    <td>{flipbookCounts.get(u.id) ?? 0}개</td>
                    <td>{c?.bonus_flipbooks ?? 0}개{c?.referred_by ? ' (추천 가입)' : ''}</td>
                    <td className="muted">{fmt(u.created_at)}</td>
                    <td className="muted">{fmt(u.last_sign_in_at)}</td>
                    <td>
                      {u.email_confirmed_at ? <span className="tag tag-ok">인증됨</span> : <span className="tag tag-no">미인증</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <section style={{ marginTop: 32 }}>
          <h2 className="panel-title" style={{ fontSize: 18 }}>신고 목록</h2>
          <p className="muted" style={{ fontSize: 13 }}>처리 대기 {reports.filter((r) => r.status === 'open').length}건</p>
          {reports.length === 0 ? (
            <div className="notice notice-info" style={{ marginTop: 12 }}>신고가 없어요.</div>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0', display: 'grid', gap: 10 }}>
              {reports.map((r) => {
                const msg = Array.isArray(r.chat_messages) ? r.chat_messages[0] ?? null : r.chat_messages
                const reporter = customers.get(r.reporter_id)
                const sender = msg ? customers.get(msg.sender_id) : undefined
                const label = r.status === 'open' ? '대기' : r.status === 'resolved' ? '처리됨' : '기각'
                const preview = !msg
                  ? '(이미 삭제됨)'
                  : msg.file_path
                    ? `[${msg.file_type?.startsWith('image/') ? '사진' : '파일'}] ${msg.file_name ?? ''}`
                    : msg.catalog_title
                      ? `[카탈로그] ${msg.catalog_title}`
                      : msg.body || '(내용 없음)'
                return (
                  <li key={r.id} className="info-box" style={{ display: 'grid', gap: 6 }}>
                    <div><strong>{label}</strong> · {fmt(r.created_at)}</div>
                    <div>신고 사유: {r.reason}</div>
                    <div>신고한 회원: {dash(reporter?.company_name || reporter?.name)}</div>
                    <div>보낸 회원: {dash(sender?.company_name || sender?.name)}</div>
                    <div>신고된 메시지: {preview}</div>
                    {r.status === 'open' && msg && r.message_id && (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                        <form action={removeReportedMessage}>
                          <input type="hidden" name="report_id" value={r.id} />
                          <input type="hidden" name="message_id" value={r.message_id} />
                          <button type="submit" className="btn btn-danger">메시지 삭제</button>
                        </form>
                        <form action={setReportStatus}>
                          <input type="hidden" name="id" value={r.id} />
                          <input type="hidden" name="status" value="resolved" />
                          <button type="submit" className="btn btn-primary">처리 완료</button>
                        </form>
                        <form action={setReportStatus}>
                          <input type="hidden" name="id" value={r.id} />
                          <input type="hidden" name="status" value="dismissed" />
                          <button type="submit" className="btn btn-ghost">기각</button>
                        </form>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>
    </main>
  )
}
