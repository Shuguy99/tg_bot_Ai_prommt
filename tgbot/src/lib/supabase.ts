import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

if (!url || !anonKey) {
  // Failing loudly at import time beats a confusing "fetch failed" later.
  throw new Error(
    'Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy .env.example to .env.local.',
  )
}

/**
 * Anon-key client. RLS allows reading active products and nothing else —
 * see supabase/migrations/0002_rls.sql. Orders are never queried from here.
 */
export const supabase: SupabaseClient = createClient(url, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

export function getSupabaseBrowserClient(): SupabaseClient {
  return supabase
}