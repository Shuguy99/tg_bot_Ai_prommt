import { useEffect, useState } from 'react'
import { isSupabaseConfigured, supabase } from '@/lib/supabase'
import type { Product } from '@/lib/types'

type State =
  | { status: 'loading' }
  | { status: 'unconfigured' }
  | { status: 'ready'; products: Product[] }
  | { status: 'error'; message: string }

/**
 * Reads the catalogue straight from Supabase with the anon key. RLS guarantees
 * only `is_active = true` rows are visible (0002_rls.sql).
 */
export function useProducts(): State {
  const [state, setState] = useState<State>(() =>
    isSupabaseConfigured ? { status: 'loading' } : { status: 'unconfigured' },
  )

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return

    let active = true

    void (async () => {
      const { data, error } = await supabase
        .from('products')
        .select('id, title, description, price, stars_price')
        .order('created_at', { ascending: true })

      if (!active) return

      if (error) {
        setState({ status: 'error', message: error.message })
        return
      }

      setState({
        status: 'ready',
        products: (data ?? []) as Product[],
      })
    })()

    return () => {
      active = false
    }
  }, [])

  return state
}