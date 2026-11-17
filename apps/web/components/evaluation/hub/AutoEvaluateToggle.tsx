'use client';
/**
 * "Auto-evaluate on connect" per-agent toggle, stored in agents.permissions.autoEvaluate (owned by the exam feature).
 * Shown only once the API exposes the field in the agent's permissions (GET /agents/:id); saved through the existing
 * PUT /agents/:id/permissions endpoint.
 */
import { Toggle } from '@/components/ui';
import { useAction } from '@/components/app/primitives';
import { api, useApi } from '@/lib/api';

type Perms = Record<string, unknown> & { autoEvaluate?: boolean };

export function AutoEvaluateToggle({ agentId, canUpdate }: { agentId: string; canUpdate: boolean }) {
  const { data, mutate } = useApi<{ permissions?: Perms }>(`/agents/${encodeURIComponent(agentId)}`, { shouldRetryOnError: false });
  const { busy, run } = useAction();
  const perms = data?.permissions;
  if (!perms || !('autoEvaluate' in perms)) return null;
  const on = perms.autoEvaluate === true;
  return (
    <div className="flex items-center gap-2" title="Screen across domains when the agent connects, then run a full professional exam in its best domains.">
      <Toggle label="Auto-evaluate on connect" checked={on} disabled={!canUpdate || busy === 'auto'}
        onChange={(v) => void run('auto', () => api.put(`/agents/${agentId}/permissions`, { ...perms, autoEvaluate: v }), v ? 'Auto-evaluation on' : 'Auto-evaluation off').then(() => mutate())} />
    </div>
  );
}
