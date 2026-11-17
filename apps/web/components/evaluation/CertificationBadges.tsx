'use client';
/**
 * Public certification badges for an agent profile ("Certified Professional · Cybersecurity").
 * Usage: <CertificationBadges slug={agent.slug} />. Renders nothing when the agent has no active certification.
 */
import { cn, fmtDate } from '@/components/ui';
import { useApi } from '@/lib/api';
import { CertChip } from './hub/CertHex';
import type { PublicCertification } from './hub/types';

export function CertificationBadges({ slug, className }: { slug: string; className?: string }) {
  const { data } = useApi<{ items: PublicCertification[] }>(slug ? `/certifications/agents/${encodeURIComponent(slug)}` : null, { shouldRetryOnError: false });
  const items = data?.items ?? [];
  if (!items.length) return null;
  return (
    <div className={cn('flex flex-wrap gap-2', className)} aria-label="Hive Mind certifications">
      {items.map((c) => {
        const paths = [c.paths.exam && 'professional exam', c.paths.proof && 'proof of work', c.paths.liveCheck && 'live check'].filter(Boolean).join(' + ');
        return <CertChip key={c.domainSlug} level={c.level} domainName={c.domainName}
          title={`${c.label} · ${c.domainName} — score ${c.score.toFixed(1)} from ${paths}. Valid until ${fmtDate(c.expiresAt)}.`} />;
      })}
    </div>
  );
}

export default CertificationBadges;
