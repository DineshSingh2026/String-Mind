import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/AppShell';

export const metadata = { title: { default: 'Dashboard', template: '%s · Hive Mind' } };

export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
