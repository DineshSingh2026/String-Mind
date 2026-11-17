'use client';
/** "How this was calculated": renders the breakdown the API stored with a certification — every number explained. */
import { fmtDate } from '@/components/ui';
import { LEVEL_SHORT, type Certification } from './types';

const Row = ({ label, value, hint }: { label: string; value: React.ReactNode; hint?: React.ReactNode }) => (
  <div className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
    <span className="text-fg-muted">{label}{hint && <span className="block text-xs text-fg-subtle">{hint}</span>}</span>
    <span className="shrink-0 tabular-nums font-medium">{value}</span>
  </div>
);

export function Breakdown({ cert }: { cert: Certification }) {
  const b = cert.breakdown ?? {};
  return (
    <div className="space-y-4 text-sm">
      <section>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Professional exam</h4>
        {b.exam ? (
          <div className="divide-y divide-line/40">
            <Row label="Exam score" value={b.exam.score} hint={`Completed ${fmtDate(b.exam.completedAt)} · certification mode`} />
            <Row label="Confidence" value={b.exam.confidence == null ? '—' : `${Math.round(b.exam.confidence * 100)}%`} hint="Must be at least 60% to count" />
          </div>
        ) : <p className="text-fg-muted">No qualifying exam (completed, certification mode, confidence ≥ 60%, within 12 months).</p>}
      </section>
      <section>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Proof of work</h4>
        {b.proof ? (
          <div className="divide-y divide-line/40">
            {b.proof.items.map((it, i) => (
              <Row key={it.id ?? i} label={it.title ?? `Evidence ${i + 1}`} value={`+${it.points}`} hint={i === 0 ? `best item (${it.score})` : `${it.score} × ${it.factor}`} />
            ))}
            <Row label="Evidence total" value={b.proof.evidenceTotal} hint={b.proof.evidenceRule} />
            {b.proof.liveCheck
              ? <Row label="Live check" value={`+${b.proof.liveCheck.points}`} hint={`${b.proof.liveCheck.score} × ${b.proof.liveCheck.weight} · scored ${fmtDate(b.proof.liveCheck.scoredAt)}`} />
              : <Row label="Live check" value="—" hint="None scored yet" />}
            <Row label="Proof score" value={b.proof.proofScore} hint={b.proof.capped ?? undefined} />
          </div>
        ) : <p className="text-fg-muted">No scored proof of work (or the proof path was voided).</p>}
      </section>
      <section className="rounded-xl bg-ink-950/50 p-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Result</h4>
        <Row label="Formula" value={<span className="text-xs">{b.combined?.formula ?? '—'}</span>} />
        <Row label="Level" value={LEVEL_SHORT[cert.level]} hint={b.level && b.level.uncappedLevel !== b.level.level ? `Would be ${LEVEL_SHORT[b.level.uncappedLevel]} without the cap` : undefined} />
        <Row label="Expires" value={fmtDate(cert.expiresAt)} hint={b.validity?.oldestResultAt ? `12 months after the oldest contributing result (${fmtDate(b.validity.oldestResultAt)})` : undefined} />
      </section>
      {!!b.notes?.length && (
        <ul className="list-disc space-y-1 pl-5 text-xs text-fg-muted">{b.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
      )}
      {b.revocation && (
        <p className="rounded-lg border border-danger/40 bg-danger/10 p-2 text-xs text-danger">
          Revoked {fmtDate(b.revocation.at)} by {b.revocation.by === 'admin' ? 'a Hive Mind administrator' : 'Hive Mind'}: {b.revocation.reason.replace(/_/g, ' ')}
        </p>
      )}
    </div>
  );
}
