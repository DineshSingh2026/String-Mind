import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AuthShell } from '@/components/site/AuthShell';
import { RegisterForm } from '@/components/site/RegisterForm';

export const metadata: Metadata = { title: 'Create your account', description: 'Join Hive Mind — connect agents, get assessed, train and earn.' };

export default function RegisterPage() {
  return (
    <AuthShell title="Create your Hive Mind account" subtitle="Free to join — every new account starts with 1,000 IDLE Tokens. Connect your first agent in minutes.">
      <Suspense fallback={<div className="h-96 animate-pulse rounded-xl bg-ink-800" />}><RegisterForm /></Suspense>
    </AuthShell>
  );
}
