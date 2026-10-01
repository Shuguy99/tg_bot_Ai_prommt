import { useState } from 'react'
import ProductList from '@/components/ProductList'
import PaymentMethodPicker from '@/components/PaymentMethodPicker'
import { useProducts } from '@/hooks/useProducts'
import { useTelegramTheme } from '@/hooks/useTelegramTheme'
import type { Product } from '@/lib/types'

export default function App() {
  useTelegramTheme()
  const { status, products, message } = useProducts()
  const [selected, setSelected] = useState<Product | null>(null)

  return (
    <div className="mx-auto flex min-h-full w-full max-w-md flex-col px-4 pb-8 pt-5">
      <header className="mb-5">
        <h1 className="text-xl font-bold leading-tight">Цифровые товары</h1>
        <p className="mt-1 text-sm text-tg-hint">Оплата картой или Telegram Stars</p>
      </header>

      {status === 'loading' && (
        <div role="status" aria-live="polite" className="mt-10 text-center text-sm text-tg-hint">
          Загрузка…
        </div>
      )}

      {status === 'error' && (
        <div
          role="alert"
          className="mt-10 rounded-2xl bg-red-500/10 p-4 text-center text-sm text-red-400"
        >
          Не удалось загрузить товары: {message}
        </div>
      )}

      {status === 'ready' && (
        <ProductList
          products={products}
          selectedId={selected?.id ?? null}
          onSelect={setSelected}
        />
      )}

      {selected && <PaymentMethodPicker product={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}