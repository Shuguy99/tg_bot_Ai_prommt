import type { Config } from 'tailwindcss'

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Mapped to Telegram theme vars injected at runtime by useTelegramTheme.
        'tg-bg': 'var(--tg-bg, #17212b)',
        'tg-text': 'var(--tg-text, #f5f5f5)',
        'tg-hint': 'var(--tg-hint, #7f8c98)',
        'tg-link': 'var(--tg-link, #62aeef)',
        'tg-button': 'var(--tg-button-bg, #3ba3ec)',
        'tg-button-text': 'var(--tg-button-text-color, #ffffff)',
      },
    },
  },
  plugins: [],
} satisfies Config