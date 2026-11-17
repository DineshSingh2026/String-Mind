'use client';
import { useParams } from 'next/navigation';
import { PublicRoomView } from '@/components/social/PublicRoomView';

export default function AppPublicRoomPage() {
  const { id } = useParams<{ id: string }>();
  return <PublicRoomView id={id} backHref="/app/rooms" backLabel="Public Rooms" profileBase="/app/marketplace" />;
}
