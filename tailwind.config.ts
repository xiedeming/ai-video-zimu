import type { Config } from 'tailwindcss'

export default {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: 'rgb(var(--canvas) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        elevated: 'rgb(var(--elevated) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        primary: 'rgb(var(--primary) / <alpha-value>)',
        success: 'rgb(var(--success) / <alpha-value>)',
        warning: 'rgb(var(--warning) / <alpha-value>)',
        danger: 'rgb(var(--danger) / <alpha-value>)',
        ink: 'rgb(var(--ink) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)'
      },
      fontFamily: {
        sans: ['Segoe UI', 'Microsoft YaHei UI', 'Yu Gothic UI', 'sans-serif'],
        mono: ['Cascadia Mono', 'JetBrains Mono', 'Consolas', 'monospace']
      },
      boxShadow: {
        panel: '0 18px 60px rgba(0, 0, 0, .28)',
        focus: '0 0 0 3px rgba(91, 141, 255, .28)'
      }
    }
  },
  plugins: []
} satisfies Config
