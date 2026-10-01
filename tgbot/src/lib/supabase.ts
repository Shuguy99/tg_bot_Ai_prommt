import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

function isPlaceholder(value: string | undefined): boolean {
  if (!value) return true
  return value.includes('your-project-ref')
}

/**
 * False when the build has no Supabase config.
 *
 * Deliberately not a thrown error at module scope: a throw here aborts the whole
 * ESM graph before React mounts, which the user sees as an unexplained blank
 * page. Callers branch on this instead and render an actionable state.
 */
export const isSupabaseConfigured: boolean =
  !isPlaceholder(url) && !isPlaceholder(anonKey) && Boolean(url && anonKey)

/**
 * Anon-key client. RLS allows reading active products and nothing else —
 * see supabase/migrations/0002_rls.sql. Orders are never queried from here.
 *
 * Null when unconfigured, so every call site has to handle it.
 */
export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url!, anonKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null