import { useState } from 'react'
import ProductList from '@/components/ProductList'
import PaymentMethodPicker from '@/components/PaymentMethodPicker'
import { useProducts } from '@/hooks/useProducts'
import { useTelegramTheme } from '@/hooks/useTelegramTheme'
import type { Product } from '@/lib/types'

export default function App() {
  useTelegramTheme()
  const state = useProducts()
  const [selected, setSelected] = useState<Product | null>(null)

  return (
    <div className="mx-auto flex min-h-full w-full max-w-md flex-col px-4 pb-8 pt-5">
      <header className="mb-5">
        <h1 className="text-xl font-bold leading-tight">Цифровые товары</h1>
        <p className="mt-1 text-sm text-tg-hint">Оплата картой или Telegram Stars</p>
      </header>

      {state.status === 'loading' && (
        <div role="status" aria-live="polite" className="mt-10 text-center text-sm text-tg-hint">
          Загрузка…
        </div>
      )}

      {state.status === 'unconfigured' && (
        <div role="alert" className="mt-10 rounded-2xl bg-amber-500/10 p-4 text-sm">
          <p className="font-medium text-amber-400">Supabase не настроен</p>
          <p className="mt-2 text-tg-hint">
            Скопируйте <code>.env.example</code> в <code>.env.local</code> и укажите{' '}
            <code>VITE_SUPABASE_URL</code> и <code>VITE_SUPABASE_ANON_KEY</code> из
            проекта Supabase, затем перезапустите dev-сервер.
          </p>
        </div>
      )}

      {state.status === 'error' && (
        <div
          role="alert"
          className="mt-10 rounded-2xl bg-red-500/10 p-4 text-center text-sm text-red-400"
        >
          Не удалось загрузить товары: {state.message}
        </div>
      )}

      {state.status === 'ready' && (
        <ProductList
          products={state.products}
          selectedId={selected?.id ?? null}
          onSelect={setSelected}
        />
      )}

      {selected && <PaymentMethodPicker product={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}