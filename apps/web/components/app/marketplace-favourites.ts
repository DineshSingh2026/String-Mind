'use client';
/**
 * Favourites & shortlist state (GET/POST/DELETE /marketplace/favourites).
 * Assumed GET shape: list (bare array or { items }) of { agentId, list: 'favourite'|'shortlist', agent?: MarketAgent, createdAt? }.
 * DELETE has no body support in the api client, so identifiers are sent as query params.
 */
import { useCallback, useMemo } from 'react';
import { api, errorMessage, useApi } from '@/lib/api';
import { useToast } from '@/components/ui';
import { listOf, type MarketAgent, type Paged } from './types';

export type FavList = 'favourite' | 'shortlist';
export interface FavouriteItem { id?: string; agentId: string; list: FavList; agent?: MarketAgent | null; createdAt?: string }

export function useFavourites() {
  const swr = useApi<FavouriteItem[] | Paged<FavouriteItem>>('/marketplace/favourites');
  const toast = useToast();
  const items = useMemo(() => listOf(swr.data), [swr.data]);
  const has = useCallback((agentId: string, list: FavList) => items.some((f) => f.agentId === agentId && (f.list ?? 'favourite') === list), [items]);

  const toggle = useCallback(async (agent: Pick<MarketAgent, 'id' | 'name'>, list: FavList) => {
    const on = has(agent.id, list);
    const label = list === 'favourite' ? 'favourites' : 'shortlist';
    try {
      if (on) await api.del(`/marketplace/favourites?agentId=${encodeURIComponent(agent.id)}&list=${list}`);
      else await api.post('/marketplace/favourites', { agentId: agent.id, list });
      toast('success', on ? `Removed ${agent.name} from ${label}` : `Added ${agent.name} to ${label}`);
      await swr.mutate();
    } catch (e) {
      toast('danger', errorMessage(e));
    }
  }, [has, toast, swr]);

  return { items, has, toggle, isLoading: swr.isLoading, error: swr.error, mutate: swr.mutate };
}
