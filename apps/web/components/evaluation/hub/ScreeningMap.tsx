'use client';
/**
 * Strengths map from the automatic on-connect screening (GET /pro-exams/screening/:agentId, owned by the exam feature).
 * Renders nothing until that endpoint exists and returns results. The response is read tolerantly:
 *   { status?, domains | strengths | results | items: [{ domainSlug | slug | domain, score | strength, status? }] }
 */
import { Radar } from 'lucide-react';
import { DOMAINS } from '@aix/shared';
import { cn } from '@/components/ui';
import { useApi } from '@/lib/api';

interface Entry { slug: string; score: number | null; status?: string }

function normalise(data: unknown): { status?: string; entries: Entry[] } {
  if (!data || typeof data !== 'object') return { entries: [] };
  const o = data as Record<string, unknown>;
  const list = [o.domains, o.strengths, o.results, o.items].find(Array.isArray) as Record<string, unknown>[] | undefined;
  const entries = (list ?? []).map((x) => {
    const slug = String(x.domainSlug ?? x.slug ?? x.domain ?? '');
    const raw = x.score ?? x.strength;
    return { slug, score: typeof raw === 'number' && Number.isFinite(raw) ? raw : null, status: typeof x.status === 'string' ? x.status : undefined };
  }).filter((e) => e.slug);
  return { status: typeof o.status === 'string' ? o.status : undefined, entries };
}

export function ScreeningMap({ agentId, onPick }: { agentId: string; onPick?: (slug: string) => void }) {
  const { data } = useApi<unknown>(`/pro-exams/screening/${encodeURIComponent(agentId)}`, { shouldRetryOnError: false });
  const { status, entries } = normalise(data);
  if (!entries.length) return null;
  const scored = entries.filter((e) => e.score != null).sort((a, b) => b.score! - a.score!);
  const pending = entries.filter((e) => e.score == null);
  const name = (s: string) => DOMAINS.find((d) => d.slug === s)?.name ?? s;
  const max = 100;
  return (
    <section className="card p-4 sm:p-5">
      <div className="mb-3 flex items-center gap-2">
        <Radar className="h-4 w-4 text-violet" aria-hidden />
        <h2 className="text-[15px] font-semibold">Screening strengths</h2>
        {status && <span className="text-xs text-fg-muted">· {status.replace(/_/g, ' ')}</span>}
      </div>
      <p className="mb-3 text-xs text-fg-muted">Automatic screening on connect. A full professional exam follows in the strongest domains. Screening scores do not certify.</p>
      <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {scored.map((e, i) => (
          <button key={e.slug} type="button" onClick={() => onPick?.(e.slug)} className="group text-left">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className={cn('truncate group-hover:underline', i < 3 ? 'font-medium text-fg' : 'text-fg-muted')}>{name(e.slug)}</span>
              <span className="tabular-nums text-fg-muted">{e.score!.toFixed(0)}</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink-800">
              <div className={cn('h-full rounded-full', i < 3 ? 'bg-gold-sheen' : 'bg-electric/60')} style={{ width: `${Math.max(2, Math.min(100, (e.score! / max) * 100))}%` }} />
            </div>
          </button>
        ))}
      </div>
      {pending.length > 0 && <p className="mt-3 text-xs text-fg-subtle">{pending.length} domain(s) still screening.</p>}
    </section>
  );
}
