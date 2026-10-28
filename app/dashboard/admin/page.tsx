import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default async function AdminPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const ADMIN_EMAILS = ['parkhy5454@gmail.com', 'modio_korea@naver.com']
  if (!ADMIN_EMAILS.includes(user.email || '')) {
    redirect('/dashboard')
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const adminClient = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceKey,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const { data: { users }, error } = await adminClient.auth.admin.listUsers()

  return (
    <div style={{ minHeight: '100vh', background: '#F5F5F5', padding: '24px', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif' }}>
      <div style={{ maxWidth: '1100px', margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
          <div>
            <h1 style={{ fontSize: '28px', fontWeight: '800', margin: '0 0 8px 0' }}>관리자 대시보드</h1>
            <p style={{ color: '#666', margin: 0 }}>총 {users?.length || 0}명의 가입자</p>
          </div>
          <a href="/dashboard" style={{ background: '#111', color: '#fff', padding: '10px 18px', borderRadius: '10px', textDecoration: 'none', fontWeight: '600', fontSize: '14px' }}>← 대시보드로</a>
        </div>

        {error && (
          <div style={{ background: '#FFE8E8', color: '#D32F2F', padding: '16px', borderRadius: '12px', marginBottom: '20px' }}>
            에러: {error.message} <br/> Vercel에 SUPABASE_SERVICE_ROLE_KEY 환경변수를 추가하세요.
          </div>
        )}

        <div style={{ background: '#fff', borderRadius: '16px', boxShadow: '0 2px 12px rgba(0,0,0,0.06)', overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
              <thead>
                <tr style={{ background: '#FAFAFA', textAlign: 'left', borderBottom: '1px solid #EEE' }}>
                  <th style={{ padding: '14px 20px', fontWeight: '700' }}>이메일</th>
                  <th style={{ padding: '14px 20px', fontWeight: '700' }}>가입일</th>
                  <th style={{ padding: '14px 20px', fontWeight: '700' }}>최근 로그인</th>
                  <th style={{ padding: '14px 20px', fontWeight: '700' }}>인증</th>
                  <th style={{ padding: '14px 20px', fontWeight: '700' }}>ID</th>
                </tr>
              </thead>
              <tbody>
                {users?.map((u: any) => (
                  <tr key={u.id} style={{ borderBottom: '1px solid #F0F0F0' }}>
                    <td style={{ padding: '14px 20px', fontWeight: '600' }}>
                      {u.email}
                      {ADMIN_EMAILS.includes(u.email) && <span style={{ marginLeft: '8px', background: '#FEE500', padding: '2px 8px', borderRadius: '20px', fontSize: '11px', fontWeight: '800' }}>ADMIN</span>}
                    </td>
                    <td style={{ padding: '14px 20px', color: '#666' }}>{new Date(u.created_at).toLocaleString('ko-KR')}</td>
                    <td style={{ padding: '14px 20px', color: '#666' }}>{u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleString('ko-KR') : '-'}</td>
                    <td style={{ padding: '14px 20px' }}>
                      {u.email_confirmed_at ? <span style={{ color: '#2E7D32', background: '#E8F5E9', padding: '4px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: '600' }}>인증됨</span> : <span style={{ color: '#D32F2F', background: '#FFEBEE', padding: '4px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: '600' }}>미인증</span>}
                    </td>
                    <td style={{ padding: '14px 20px', color: '#999', fontSize: '11px', fontFamily: 'monospace' }}>{u.id.slice(0,8)}...</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ marginTop: '20px', background: '#FFF9C4', padding: '16px', borderRadius: '12px', fontSize: '13px', color: '#5D4037' }}>
          💡 Vercel → Settings → Environment Variables → SUPABASE_SERVICE_ROLE_KEY에 sb_secret_... 값을 추가해야 전체 목록이 보입니다.
        </div>
      </div>
    </div>
  )
}
