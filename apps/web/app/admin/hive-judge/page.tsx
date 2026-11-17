'use client';
import { useState } from 'react';
import { Alert, Badge, Button, Card, CardBody, CardHeader, PageHeader, Spinner, Table, Td, fmtDateTime, useToast } from '@/components/ui';
import { api, errorMessage, useApi } from '@/lib/api';

type Block = { answers: number; mae: number | null; within10: number | null; rankOrderAccuracy: number | null; levelOrderAccuracy: number | null; redFlagRecall: number | null; genericAtMost45: number | null; redFlagFalsePositiveOnExpert: number | null };
type Metrics = { version: number; trainedAt: string; label: string; data: Record<string, unknown>; cv: { method?: string; note?: string; overall?: Block; byDomain?: Record<string, Block>; byGradingMode?: Record<string, Block> } };
type Review = { id: string; domain: string; status: string; createdAt: string; task: string; suggestedTotal: number; confidence?: number; reasons: string[] };

const v = (x: number | null | undefined, s = '') => (x == null ? '—' : `${x}${s}`);

/** Hive Judge admin: honest accuracy metrics, retrain, and the (optional) expert review queue. */
export default function HiveJudgePage() {
  const toast = useToast();
  const metrics = useApi<Metrics>('/hive-judge/metrics');
  const reviews = useApi<{ reviews: Review[] }>('/hive-judge/reviews?status=open');
  const [busy, setBusy] = useState(false);
  const train = async () => {
    setBusy(true);
    try { await api.post('/hive-judge/train'); await metrics.mutate(); toast('success', 'Hive Judge retrained'); }
    catch (e) { toast('danger', errorMessage(e)); }
    finally { setBusy(false); }
  };
  const m = metrics.data;
  const rows = (blocks?: Record<string, Block>) => Object.entries(blocks ?? {}).map(([k, b]) => (
    <tr key={k}><Td>{k}</Td><Td>{b.answers}</Td><Td>{v(b.mae)}</Td><Td>{v(b.within10, '%')}</Td><Td>{v(b.rankOrderAccuracy, '%')}</Td><Td>{v(b.redFlagRecall, '%')}</Td><Td>{v(b.genericAtMost45, '%')}</Td></tr>
  ));
  return (
    <div className="space-y-6">
      <PageHeader title="Hive Judge" description="Local, CPU-only judge: deterministic checks → calibrated rubric scorer → optional local LLM → optional admin review." actions={<Button variant="primary" loading={busy} onClick={train}>Retrain now</Button>} />
      {metrics.isLoading && <Spinner />}
      {m && (
        <>
          <Alert tone="warning" title={m.label}>Metrics are cross-validated on held-out questions; they only describe the calibration data listed below.</Alert>
          <Card>
            <CardHeader title={`Model v${m.version}`} subtitle={`trained ${fmtDateTime(m.trainedAt)} · ${m.cv.method ?? m.cv.note ?? ''}`} />
            <CardBody><pre className="overflow-x-auto text-xs text-fg-muted">{JSON.stringify(m.data, null, 2)}</pre></CardBody>
          </Card>
          <Card>
            <CardHeader title="Accuracy (held-out folds)" />
            <Table head={['Group', 'Answers', 'MAE', '≤10 pts', 'Rank order', 'Red-flag recall', 'Generic ≤45']}>
              {m.cv.overall && rows({ overall: m.cv.overall })}
              {rows(m.cv.byGradingMode)}
              {rows(m.cv.byDomain)}
            </Table>
          </Card>
        </>
      )}
      <Card>
        <CardHeader title="Expert review queue" subtitle="Off by default (settings.reviewEnabled). Resolve via POST /hive-judge/reviews/:id/resolve." />
        <Table head={['Created', 'Domain', 'Task', 'Suggested', 'Confidence', 'Why']}>
          {(reviews.data?.reviews ?? []).map((r) => (
            <tr key={r.id}><Td>{fmtDateTime(r.createdAt)}</Td><Td>{r.domain}</Td><Td className="max-w-md truncate">{r.task}</Td><Td>{r.suggestedTotal}</Td><Td><Badge>{v(r.confidence)}</Badge></Td><Td className="text-xs">{r.reasons.join(', ')}</Td></tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
