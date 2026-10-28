import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
export const dynamic = 'force-dynamic'
export default async function Home() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return (
    <div style={{minHeight:'100vh', background:'radial-gradient(ellipse at 50% 0%, #2a1840 0%, #0e0a14 60%)', color:'white'}}>
      <header style={{display:'flex', justifyContent:'space-between', alignItems:'center', padding:'20px 24px', maxWidth:'1100px', margin:'0 auto'}}>
        <div style={{fontWeight:900, letterSpacing:'-0.5px', color:'#ff5a6a'}}>CATALOGTALK</div>
        <div style={{display:'flex', gap:'8px'}}>
          {user ? (<><span style={{color:'rgba(255,255,255,0.6)', fontSize:'13px', padding:'8px 12px'}}>{user.email}</span><Link href='/dashboard' style={{background:'white', color:'black', textDecoration:'none', padding:'8px 16px', borderRadius:'20px', fontSize:'13px', fontWeight:700 as any}}>대시보드</Link></>) : (<><Link href='/login' style={{color:'white', textDecoration:'none', padding:'8px 16px', borderRadius:'20px', border:'1px solid rgba(255,255,255,0.2)', fontSize:'13px'}}>로그인</Link><Link href='/signup' style={{background:'white', color:'black', textDecoration:'none', padding:'8px 16px', borderRadius:'20px', fontSize:'13px', fontWeight:700 as any}}>시작하기</Link></>)}
        </div>
      </header>
      <main style={{maxWidth:'1100px', margin:'0 auto', padding:'80px 24px', textAlign:'center' as any}}>
        <h1 style={{fontSize:'56px', fontWeight:900, lineHeight:'1.1', margin:'0 0 20px 0'}}>카탈로그를<br/>살아있는 경험으로</h1>
        <div style={{display:'flex', gap:'12px', justifyContent:'center'}}>{user ? <Link href='/dashboard' style={{background:'white', color:'black', padding:'14px 28px', borderRadius:'12px', fontWeight:800, textDecoration:'none'}}>대시보드로 이동 →</Link> : <Link href='/signup' style={{background:'white', color:'black', padding:'14px 28px', borderRadius:'12px', fontWeight:800, textDecoration:'none'}}>무료로 시작하기 →</Link>}</div>
      </main>
    </div>
  )
}
