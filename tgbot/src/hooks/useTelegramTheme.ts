import { useEffect } from 'react'
import { applyTheme, ready } from '@/lib/telegram'

export function useTelegramTheme(): void {
  useEffect(() => {
    ready()
    applyTheme()
  }, [])
}