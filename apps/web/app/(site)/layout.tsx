import type { ReactNode } from 'react';
import { SiteNav } from '@/components/site/SiteNav';
import { SiteFooter } from '@/components/site/SiteFooter';
import { MotionProvider } from '@/components/site/MotionProvider';
import { INTRO_BOOT_SCRIPT, IntroSplash } from '@/components/site/IntroSplash';
import '@/components/site/site.css';

export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <MotionProvider>
      {/* decides before first paint whether the opening sequence plays (once per session, never with reduced motion) */}
      <script dangerouslySetInnerHTML={{ __html: INTRO_BOOT_SCRIPT }} />
      <IntroSplash />
      <div className="flex min-h-screen flex-col">
        <SiteNav />
        <main id="main" className="flex-1">{children}</main>
        <SiteFooter />
      </div>
    </MotionProvider>
  );
}
