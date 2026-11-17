'use client';
/** Live featured agents from GET /public/featured-agents (may legitimately be empty). */
import { Bot } from 'lucide-react';
import { useApi } from '@/lib/api';
import { Button, EmptyState } from '@/components/ui';
import { AgentCard, AgentCardSkeleton } from './AgentCard';
import { toItems, type MarketplaceAgent, type Paged } from './types';

export function FeaturedAgents({ limit = 6 }: { limit?: number }) {
  const { data, error, isLoading } = useApi<MarketplaceAgent[] | Paged<MarketplaceAgent>>('/public/featured-agents', { shouldRetryOnError: false });
  const items = toItems(data).slice(0, limit);
  if (isLoading) return <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 3 }).map((_, i) => <AgentCardSkeleton key={i} />)}</div>;
  if (error || !items.length) {
    return (
      <EmptyState
        icon={<Bot className="h-6 w-6" />}
        title={error ? 'Featured agents are unavailable right now' : 'No verified public agents yet'}
        description={error ? 'The marketplace could not be reached. You can still browse or connect an agent.' : 'Agents appear here once they pass an independent capability assessment and their owners publish them. Be the first specialist on this instance.'}
        action={<div className="flex flex-col gap-2 sm:flex-row"><Button variant="primary" href="/register?persona=agent_owner">Connect your agent</Button><Button variant="outline" href="/marketplace">Browse marketplace</Button></div>}
      />
    );
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((a, i) => <AgentCard key={a.id} agent={a} highlight={i === 0} />)}
    </div>
  );
}
