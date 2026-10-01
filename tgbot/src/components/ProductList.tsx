import ProductCard from './ProductCard'
import type { Product } from '@/lib/types'

interface Props {
  products: Product[]
  selectedId: string | null
  onSelect: (product: Product) => void
}

export default function ProductList({ products, selectedId, onSelect }: Props) {
  if (products.length === 0) {
    return (
      <p className="mt-8 text-center text-sm text-tg-hint">
        Товаров пока нет. Добавьте записи в таблицу <code>products</code>.
      </p>
    )
  }

  return (
    <ul className="flex flex-col gap-3">
      {products.map((product) => (
        <ProductCard
          key={product.id}
          product={product}
          disabled={selectedId !== null && selectedId !== product.id}
          onSelect={onSelect}
        />
      ))}
    </ul>
  )
}