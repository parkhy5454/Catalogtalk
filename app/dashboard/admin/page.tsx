import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

// Only operators (customers.is_admin = true, set in the database) may view this page.

type AuthUser = {
  id: string
  email?: string
  created_at: string
  last_sign_in_at?: string | null
  email_confirmed_at?: string | null
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
    </main>
  )
}
