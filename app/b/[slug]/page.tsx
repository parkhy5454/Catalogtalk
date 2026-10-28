'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useParams } from 'next/navigation'
export default function ViewerPage() {
  const params = useParams()
  const rawSlug = params.slug as string
  const slug = decodeURIComponent(rawSlug)
  const [flipbook, setFlipbook] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const supabase = createClient()
  useEffect(() => {
    const fetch = async () => {
      let { data } = await supabase.from('flipbooks').select('*').eq('slug', slug).maybeSingle()
      if (!data) {
        const res = await supabase.from('flipbooks').select('*').eq('slug', rawSlug).maybeSingle()
        data = res.data
      }
      if (data) {
        setFlipbook(data)
        supabase.from('flipbooks').update({ views: (data.views || 0) + 1 }).eq('id', data.id).then(()=>{})
      }
      setLoading(false)
    }
    if (slug) fetch()
  }, [slug, rawSlug])
  if (loading) return <div style={{display:'flex', alignItems:'center', justifyContent:'center', minHeight:'100vh', background:'#F5F5F5'}}>로딩 중... {slug}</div>
  if (!flipbook) return <div style={{display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', minHeight:'100vh', background:'#F5F5F5', fontFamily:'sans-serif'}}><div>플립북을 찾을 수 없어요</div><div style={{color:'#999', fontSize:'12px', marginTop:'8px'}}>{slug}</div><a href='/dashboard' style={{marginTop:'16px', background:'#111', color:'#fff', padding:'10px 20px', borderRadius:'10px', textDecoration:'none'}}>대시보드로</a></div>
  return (
    <div style={{minHeight:'100vh', background:'#111', display:'flex', flexDirection:'column'}}>
      <div style={{flex:1, position:'relative'}}><iframe src={flipbook.pdf_url} style={{width:'100%', height:'100vh', border:'none'}} title={flipbook.title} /></div>
      <div style={{position:'fixed', bottom:'20px', left:'50%', transform:'translateX(-50%)', background:'rgba(0,0,0,0.8)', color:'white', padding:'8px 16px', borderRadius:'20px', fontSize:'12px'}}>{flipbook.title} - 조회수 {flipbook.views || 0}회</div>
    </div>
  )
}
