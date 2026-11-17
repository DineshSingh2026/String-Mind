import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/AppShell';

export const metadata = { title: { default: 'Dashboard', template: '%s · StringMind' } };

export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
