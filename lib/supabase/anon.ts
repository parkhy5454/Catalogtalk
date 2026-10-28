// Cookie-less Supabase client for public, server-side reads (metadata, viewer data).
import { createClient as createSupabaseClient } from '@supabase/supabase-js'

export function createAnonClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  )
}
