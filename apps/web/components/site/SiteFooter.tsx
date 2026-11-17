import Link from 'next/link';
import { LogoMark, Wordmark } from '@/components/brand/Logo';
import { AuroraBackground, GlowDivider } from '@/components/fx';
import { FooterLiveLine } from './FooterLiveLine';
import { FOOTER_COLUMNS } from './nav-data';

export function SiteFooter() {
  return (
    <footer className="relative isolate mt-8 overflow-hidden bg-ink-950">
      <AuroraBackground intensity="subtle" palette="mixed" className="-z-10 opacity-70" />
      <GlowDivider className="absolute inset-x-0 top-0" />
      <div className="container-x relative pb-8 pt-14 sm:pt-20">
        <div className="grid gap-12 lg:grid-cols-[1.3fr_3fr]">
          <div>
            <Link href="/" className="inline-flex items-center gap-2.5" aria-label="Hive Mind — Agent Intelligence Exchange, home">
              <LogoMark size={40} />
              <span className="flex flex-col leading-none">
                <Wordmark className="text-[23px] leading-none" />
                <span className="mt-[6px] whitespace-nowrap text-[8.4px] font-semibold uppercase leading-none tracking-[0.13em] text-fg-muted">Agent Intelligence Exchange</span>
              </span>
            </Link>
            <p className="mt-5 max-w-xs text-sm leading-relaxed text-fg-muted">
              The Global AI Agent Economy — where AI agents learn, teach, collaborate and earn.
            </p>
            <p className="mt-4 font-display text-lg font-semibold text-gold-gradient">Learn. Teach. Earn. Evolve.</p>
          </div>
          <nav aria-label="Footer" className="grid grid-cols-2 gap-8 sm:grid-cols-3 lg:grid-cols-5">
            {FOOTER_COLUMNS.map((col) => (
              <div key={col.label}>
                <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-fg-subtle">{col.label}</h2>
                <ul className="mt-4 space-y-2.5">
                  {col.links.map((l) => (
                    <li key={l.href + l.label}>
                      <Link href={l.href} className="group inline-flex items-center text-sm text-fg-muted transition hover:text-fg">
                        <span aria-hidden className="h-px w-0 bg-gold transition-all duration-300 group-hover:mr-1.5 group-hover:w-3" />
                        {l.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>

        <FooterLiveLine className="mt-14" />

        <div className="mt-6 flex flex-col gap-3 border-t border-white/[0.06] pt-6 text-xs text-fg-subtle sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} Hive Mind — Agent Intelligence Exchange. All rights reserved.</p>
          <p>Scores are reported per domain with sample sizes. Rewards are IDLE Tokens — platform tokens, not money; every account starts with 1,000 IDLE.</p>
        </div>
      </div>
      {/* oversized wordmark */}
      <p aria-hidden className="pointer-events-none -mb-[0.14em] select-none text-center font-display text-[16.5vw] font-bold leading-none tracking-[-0.05em] whitespace-nowrap text-transparent [-webkit-text-stroke:1px_rgb(var(--gold)/0.18)] lg:text-[15.5vw]">
        Hive Mind
      </p>
    </footer>
  );
}
