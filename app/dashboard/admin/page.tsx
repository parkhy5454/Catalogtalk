import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

// Only the operator may view this page. Keep in sync with the plan (기획서 4.6).
const ADMIN_EMAILS = ['parkhy5454@gmail.com']

type AuthUser = {
  id: string
  email?: string
  created_at: string
  last_sign_in_at?: string | null
  email_confirmed_at?: string | null
}

export default async function AdminPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  if (!ADMIN_EMAILS.includes(user.email || '')) redirect('/dashboard')

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  let users: AuthUser[] = []
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
  }

  const fmt = (s?: string | null) => (s ? new Date(s).toLocaleString('ko-KR') : '-')

  return (
    <div className="page">
      <main className="container section">
        <div className="panel-head" style={{ marginBottom: 16 }}>
          <div>
            <h1 className="panel-title" style={{ fontSize: 22 }}>관리자 대시보드</h1>
            <p className="muted" style={{ fontSize: 14 }}>총 {users.length.toLocaleString()}명의 가입자</p>
          </div>
          <Link href="/dashboard" className="btn btn-primary">← 대시보드</Link>
        </div>

        {error && <div className="notice notice-error" role="alert" style={{ marginBottom: 16 }}>에러: {error}</div>}

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">이메일</th>
                <th scope="col">가입일</th>
                <th scope="col">최근 로그인</th>
                <th scope="col">인증</th>
                <th scope="col">ID</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td style={{ fontWeight: 600 }}>
                    {u.email}
                    {ADMIN_EMAILS.includes(u.email || '') && <span className="badge-admin">ADMIN</span>}
                  </td>
                  <td className="muted">{fmt(u.created_at)}</td>
                  <td className="muted">{fmt(u.last_sign_in_at)}</td>
                  <td>
                    {u.email_confirmed_at ? <span className="tag tag-ok">인증됨</span> : <span className="tag tag-no">미인증</span>}
                  </td>
                  <td className="muted" style={{ fontFamily: 'monospace', fontSize: 12 }}>{u.id.slice(0, 8)}…</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  )
}
