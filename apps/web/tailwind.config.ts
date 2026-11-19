import type { Config } from 'tailwindcss';

/**
 * Hive Mind design tokens. Dark background with glowing colour accents:
 * ink (near-black surfaces), gold (honey primary: CTAs/rewards), the hive spectrum
 * (coral, magenta, violet, electric blue, cyan, mint) for accents and per-agent colour, electric (AI/tech),
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
        coral: v('coral'),
        magenta: v('magenta'),
        cyan: v('cyan'),
        mint: v('mint'),
        success: { DEFAULT: v('success'), soft: v('success-soft') },
        warning: v('warning'),
        danger: { DEFAULT: v('danger'), soft: v('danger-soft') },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'var(--font-sans)', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
        lux: ['var(--font-lux)', 'Georgia', 'serif'],
      },
      borderRadius: { xl: '0.875rem', '2xl': '1.125rem' },
      boxShadow: {
        card: '0 1px 0 0 rgb(255 255 255 / 0.04) inset, 0 8px 24px -12px rgb(0 0 0 / 0.6)',
        gold: '0 8px 28px -10px rgb(var(--magenta) / 0.5), 0 4px 16px -8px rgb(var(--gold) / 0.5)',
        glow: '0 0 0 1px rgb(var(--violet) / 0.25), 0 0 32px -6px rgb(var(--violet) / 0.45)',
        focus: '0 0 0 3px rgb(var(--electric) / 0.45)',
      },
      backgroundImage: {
        'grid-fade': 'linear-gradient(to bottom, transparent, rgb(var(--ink-950))), linear-gradient(rgb(var(--line) / 0.35) 1px, transparent 1px), linear-gradient(90deg, rgb(var(--line) / 0.35) 1px, transparent 1px)',
        // The shifting brand spectrum (animated in globals.css). Primary CTAs and highlight text.
        'gold-sheen': 'linear-gradient(115deg, rgb(var(--gold)) 0%, rgb(var(--coral)) 22%, rgb(var(--magenta)) 42%, rgb(var(--violet)) 64%, rgb(var(--cyan)) 84%, rgb(var(--gold)) 100%)',
        'hive-sheen': 'linear-gradient(115deg, rgb(var(--gold)) 0%, rgb(var(--coral)) 18%, rgb(var(--magenta)) 36%, rgb(var(--violet)) 54%, rgb(var(--electric)) 70%, rgb(var(--cyan)) 85%, rgb(var(--mint)) 100%)',
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
