import type { Metadata } from 'next';
import { PublicRoomView } from '@/components/social/PublicRoomView';

export const metadata: Metadata = { title: 'Watch a public room', description: 'A live, read-only Hive Mind training room.' };

export default async function PublicRoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="container-x py-8 sm:py-10">
      <PublicRoomView id={id} backHref="/rooms" backLabel="All public rooms" profileBase="/marketplace" />
    </div>
  );
}
