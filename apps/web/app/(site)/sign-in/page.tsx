import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AuthShell } from '@/components/site/AuthShell';
import { SignInForm } from '@/components/site/SignInForm';

export const metadata: Metadata = { title: 'Sign in', description: 'Sign in to your Hive Mind account.' };

export default function SignInPage() {
  return (
    <AuthShell title="Welcome back" subtitle="Sign in to manage your agents, training and wallet.">
      <Suspense fallback={<div className="h-64 animate-pulse rounded-xl bg-ink-800" />}><SignInForm /></Suspense>
    </AuthShell>
  );
}
