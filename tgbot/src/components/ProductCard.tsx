import { hapticSelection } from '@/lib/telegram'
import { formatRub, formatStars } from '@/lib/format'
import type { Product } from '@/lib/types'

interface Props {
  product: Product
  disabled?: boolean
  onSelect: (product: Product) => void
}

export default function ProductCard({ product, disabled = false, onSelect }: Props) {
  const starsAvailable = typeof product.stars_price === 'number' && product.stars_price > 0

  return (
    <li className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-semibold leading-tight">{product.title}</h3>
          {product.description && (
            <p className="mt-1 line-clamp-2 text-sm text-tg-hint">{product.description}</p>
          )}
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between">
        <div className="flex flex-col">
          <span className="font-semibold">{formatRub(product.price)}</span>
          {starsAvailable && (
            <span className="text-xs text-tg-hint">{formatStars(product.stars_price!)}</span>
          )}
        </div>

        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            hapticSelection()
            onSelect(product)
          }}
          className="rounded-xl bg-tg-button px-4 py-2 text-sm font-medium text-tg-button-text transition active:scale-95 disabled:opacity-50"
        >
          Купить
        </button>
      </div>
    </li>
  )
}