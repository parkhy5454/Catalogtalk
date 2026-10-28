'use client'
import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

export default function ProfilePage() {
  const [user, setUser] = useState<any>(null)
  const [newPassword, setNewPassword] = useState('')
  const [msg, setMsg] = useState('')
  const router = useRouter()
  const supabase = createClient()

  useEffect(() => { supabase.auth.getUser().then(({ data }) => setUser(data.user)) }, [])

  const updatePassword = async () => {
    if (newPassword.length < 6) { setMsg('비밀번호는 6자 이상이어야 해요'); return }
    const { error } = await supabase.auth.updateUser({ password: newPassword })
    if (error) setMsg('오류: ' + error.message)
    else { setMsg('✅ 비밀번호가 변경되었어요!'); setNewPassword('') }
  }

  return (
    <div style={{ minHeight: '100vh', background: '#FEE500', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif' }}>
      <div style={{ background: '#fff', borderRadius: '20px', padding: '32px', width: '100%', maxWidth: '420px', boxShadow: '0 8px 32px rgba(0,0,0,0.12)' }}>
        <h1 style={{ fontSize: '22px', fontWeight: '800', margin: '0 0 20px 0' }}>내 정보</h1>
        <div style={{ background: '#FAFAFA', padding: '16px', borderRadius: '12px', marginBottom: '20px' }}>
          <div style={{ fontSize: '13px', color: '#999', marginBottom: '4px' }}>이메일</div>
          <div style={{ fontWeight: '700' }}>{user?.email}</div>
          <div style={{ fontSize: '12px', color: '#999', marginTop: '8px' }}>가입일: {user?.created_at ? new Date(user.created_at).toLocaleDateString('ko-KR') : '-'}</div>
        </div>
        <div style={{ marginBottom: '20px' }}>
          <label style={{ fontSize: '13px', fontWeight: '600', display: 'block', marginBottom: '8px' }}>새 비밀번호</label>
          <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="6자 이상 입력"
            style={{ width: '100%', padding: '12px 14px', borderRadius: '10px', border: '1px solid #E0E0E0', fontSize: '14px', boxSizing: 'border-box' }} />
          <button onClick={updatePassword} style={{ width: '100%', marginTop: '10px', background: '#111', color: '#fff', border: 'none', padding: '12px', borderRadius: '10px', fontWeight: '700', cursor: 'pointer' }}>비밀번호 변경</button>
        </div>
        {msg && <div style={{ padding: '12px', borderRadius: '10px', background: msg.includes('✅') ? '#E8F5E9' : '#FFEBEE', color: msg.includes('✅') ? '#2E7D32' : '#D32F2F', fontSize: '13px', marginBottom: '16px' }}>{msg}</div>}
        <div style={{ display: 'flex', gap: '10px' }}>
          <a href="/dashboard" style={{ flex: 1, textAlign: 'center', background: '#F5F5F5', padding: '12px', borderRadius: '10px', textDecoration: 'none', color: '#111', fontWeight: '600', fontSize: '14px' }}>대시보드</a>
          <button onClick={async () => { await supabase.auth.signOut(); router.push('/login') }} style={{ flex: 1, background: '#fff', border: '1px solid #E0E0E0', padding: '12px', borderRadius: '10px', fontWeight: '600', fontSize: '14px', cursor: 'pointer' }}>로그아웃</button>
        </div>
      </div>
    </div>
  )
}
