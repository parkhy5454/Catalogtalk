'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useParams } from 'next/navigation'

export default function ViewerPage() {
  const params = useParams()
  const slug = params.slug as string
  const [flipbook, setFlipbook] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const supabase = createClient()

  useEffect(() => {
    const fetch = async () => {
      const { data } = await supabase.from('flipbooks').select('*').eq('slug', slug).single()
      if (data) {
        setFlipbook(data)
        // views increment
        supabase.rpc('increment_view', { fb_id: data.id })
        supabase.from('flipbook_views').insert({ flipbook_id: data.id })
      }
      setLoading(false)
    }
    fetch()
  }, [slug])

  if (loading) return <div style={{display:'flex', alignItems:'center', justifyContent:'center', minHeight:'100vh'}}>로딩 중...</div>
  if (!flipbook) return <div style={{display:'flex', alignItems:'center', justifyContent:'center', minHeight:'100vh'}}>플립북을 찾을 수 없어요</div>

  return (
    <div style={{minHeight:'100vh', background:'#111'}}>
      <iframe src={flipbook.pdf_url} style={{width:'100%', height:'100vh', border:'none'}} title={flipbook.title} />
      <div style={{position:'fixed', bottom:'20px', left:'50%', transform:'translateX(-50%)', background:'rgba(0,0,0,0.8)', color:'white', padding:'8px 16px', borderRadius:'20px', fontSize:'12px'}}>
        {flipbook.title} • 조회수 {flipbook.views}회
      </div>
    </div>
  )
}