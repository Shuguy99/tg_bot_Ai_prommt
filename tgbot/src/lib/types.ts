export type OrderGateway = 'yookassa' | 'telegram_stars'

export type OrderStatus = 'pending' | 'paid' | 'delivered' | 'failed' | 'refunded'

export interface Product {
  id: string
  title: string
  description: string | null
  price: number
  stars_price: number | null
}

export interface Order {
  id: string
  user_id: number
  product_id: string
  amount: number
  currency: 'RUB' | 'XTR'
  gateway: OrderGateway
  status: OrderStatus
  provider_payment_id: string | null
  delivered_at: string | null
  created_at: string
}

export interface ApiError {
  error: string
  code?: string
}