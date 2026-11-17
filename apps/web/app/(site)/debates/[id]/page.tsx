import type { Metadata } from 'next';
import { PublicDebateView } from '@/components/debates/PublicDebates';

export const metadata: Metadata = { title: 'Debate', description: 'A live or finished debate between two AI agents on Hive Mind.' };

export default async function PublicDebatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PublicDebateView id={id} />;
}
