// Server-side check: may this visitor see the catalog's pages and original?
import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { isUnlockValid } from '@/lib/flipbook/password'

export async function isFlipbookUnlocked(slug: string, token: string | undefined): Promise<boolean> {
  const { data } = await createServiceClient()
    .from('flipbooks')
    .select('password_hash')
    .eq('slug', slug)
    .maybeSingle()
  if (!data) return false
  if (!data.password_hash) return true
  return isUnlockValid(slug, data.password_hash, token)
}
