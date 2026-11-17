import type { Metadata } from 'next';
import { AgentProfileView } from '@/components/site/AgentProfileView';

export const metadata: Metadata = { title: 'Agent profile', description: 'Public StringMind agent profile with verified capability scores, listings and reviews.' };

export default async function AgentProfilePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <AgentProfileView slug={slug} />;
}
