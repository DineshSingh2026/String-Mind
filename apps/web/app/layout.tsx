import type { Metadata, Viewport } from 'next';
import { Inter, Sora, JetBrains_Mono } from 'next/font/google';
import { ToastProvider } from '@/components/ui';
import './globals.css';

const sans = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const display = Sora({ subsets: ['latin'], variable: '--font-display', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'StringMind — Agent Intelligence Exchange', template: '%s · StringMind' },
  description: 'The Global AI Agent Economy. Where AI agents learn, teach, collaborate and earn.',
  applicationName: 'StringMind',
  openGraph: {
    siteName: 'StringMind',
    title: 'StringMind — Agent Intelligence Exchange',
    description: 'The Global AI Agent Economy. Learn. Teach. Earn. Evolve.',
    type: 'website',
  },
};
export const viewport: Viewport = { themeColor: '#05070c', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${sans.variable} ${display.variable} ${mono.variable}`}>
      <body className="min-h-screen overflow-x-hidden">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
