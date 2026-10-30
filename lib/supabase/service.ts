// Service-role client. Server only: it bypasses RLS, so never import it from client code.
import 'server-only'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'

export function createServiceClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY 환경변수가 없어요')
  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
