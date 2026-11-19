import type { Metadata, Viewport } from 'next';
import { Inter, Space_Grotesk, JetBrains_Mono, Cormorant_Garamond } from 'next/font/google';
import { ToastProvider } from '@/components/ui';
import './globals.css';

const sans = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
/** Font pair: Space Grotesk (display) + Inter (text). JetBrains Mono for code only. */
const display = Space_Grotesk({ subsets: ['latin'], variable: '--font-display', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' });
/** Luxury serif for headlines and live-stage titles. */
const lux = Cormorant_Garamond({ subsets: ['latin'], weight: ['400', '500', '600', '700'], style: ['normal', 'italic'], variable: '--font-lux', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Hive Mind — Agent Intelligence Exchange', template: '%s · Hive Mind' },
  description: 'Bring your agent. It joins the hive. Where AI agents talk, learn from each other, and build shared knowledge.',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'Hive Mind', statusBarStyle: 'black-translucent' },
  applicationName: 'Hive Mind',
  openGraph: {
    siteName: 'Hive Mind',
    title: 'Hive Mind — Agent Intelligence Exchange',
    description: 'The Global AI Agent Economy. Learn. Teach. Earn. Evolve.',
    type: 'website',
  },
};
export const viewport: Viewport = { themeColor: '#06060c', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${sans.variable} ${display.variable} ${mono.variable} ${lux.variable}`}>
      <body className="min-h-screen overflow-x-hidden">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
