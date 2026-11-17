import type { Config } from 'tailwindcss';

/**
 * StringMind design tokens. Dark-first premium palette:
 * ink (deep black → midnight navy surfaces), gold (CTAs/rewards), electric (AI/tech),
 * violet (AI/tech secondary), success (verified/positive), danger, warning.
 * Colours are CSS variables (see app/globals.css) so they can be themed.
 */
const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { 950: v('ink-950'), 900: v('ink-900'), 850: v('ink-850'), 800: v('ink-800'), 700: v('ink-700'), 600: v('ink-600') },
        line: v('line'),
        fg: { DEFAULT: v('fg'), muted: v('fg-muted'), subtle: v('fg-subtle') },
        gold: { DEFAULT: v('gold'), soft: v('gold-soft'), deep: v('gold-deep') },
        electric: { DEFAULT: v('electric'), soft: v('electric-soft') },
        violet: { DEFAULT: v('violet'), soft: v('violet-soft') },
        success: { DEFAULT: v('success'), soft: v('success-soft') },
        warning: v('warning'),
        danger: { DEFAULT: v('danger'), soft: v('danger-soft') },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'var(--font-sans)', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      borderRadius: { xl: '0.875rem', '2xl': '1.125rem' },
      boxShadow: {
        card: '0 1px 0 0 rgb(255 255 255 / 0.04) inset, 0 8px 24px -12px rgb(0 0 0 / 0.6)',
        gold: '0 8px 24px -10px rgb(var(--gold) / 0.55)',
        focus: '0 0 0 3px rgb(var(--electric) / 0.45)',
      },
      backgroundImage: {
        'grid-fade': 'linear-gradient(to bottom, transparent, rgb(var(--ink-950))), linear-gradient(rgb(var(--line) / 0.35) 1px, transparent 1px), linear-gradient(90deg, rgb(var(--line) / 0.35) 1px, transparent 1px)',
        'gold-sheen': 'linear-gradient(135deg, rgb(var(--gold-soft)) 0%, rgb(var(--gold)) 45%, rgb(var(--gold-deep)) 100%)',
        'ai-sheen': 'linear-gradient(135deg, rgb(var(--electric)) 0%, rgb(var(--violet)) 100%)',
      },
      keyframes: {
        'fade-up': { from: { opacity: '0', transform: 'translateY(6px)' }, to: { opacity: '1', transform: 'none' } },
        pulseDot: { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.35' } },
      },
      animation: { 'fade-up': 'fade-up .35s ease-out both', 'pulse-dot': 'pulseDot 1.6s ease-in-out infinite' },
    },
  },
  plugins: [],
} satisfies Config;
