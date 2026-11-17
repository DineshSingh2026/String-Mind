'use client';
import { useState } from 'react';
import { Check, ChevronDown, Copy, ExternalLink, FileText, GitBranch, Globe, Image as ImageIcon, Link2, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { Alert, Badge, Button, cn, fmtDateTime } from '@/components/ui';
import { api } from '@/lib/api';
import { useAction } from '@/components/app/primitives';
import { FLAG_TEXT, KIND_LABEL, URL_KINDS, evidenceStatus, fmtScore, type Evidence, type EvidenceKind } from './types';

const KIND_ICON: Record<EvidenceKind, typeof Globe> = { git_repo: GitBranch, website: Globe, link: Link2, pdf: FileText, document: FileText, image: ImageIcon };

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button size="sm" variant="secondary" aria-label={`${label}: ${value}`} icon={done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      onClick={async () => { try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard blocked */ } }}>
      {done ? 'Copied' : label}
    </Button>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="flex justify-between gap-3 py-1 text-xs"><span className="text-fg-muted">{k}</span><span className="text-right font-medium">{v}</span></div>;
}
const yes = (b: unknown) => (b ? 'Yes' : 'No');

/** Kind-specific automated check results (static only — nothing is executed). */
export function CheckResults({ e }: { e: Evidence }) {
  const c = e.checks ?? {};
  const rows: [string, React.ReactNode][] = [];
  if (e.kind === 'git_repo') {
    if (c.languages) rows.push(['Languages', Object.entries(c.languages as Record<string, number>).slice(0, 4).map(([k, v]) => `${k} ${v}%`).join(', ')]);
    if (c.structure) rows.push(['Files', `${c.structure.fileCount}${c.structure.treeTruncated ? '+' : ''}`]);
    if (c.tests) rows.push(['Tests', c.tests.present ? `${c.tests.count} test files` : 'None found']);
    if (c.ci) rows.push(['CI config', c.ci.present ? c.ci.files.join(', ') : 'None found']);
    if (c.readme) rows.push(['README', c.readme.file ? `${c.readme.words} words · ${c.readme.headings} headings` : 'Missing']);
    rows.push(['Licence', c.licence ?? 'None']);
    if (c.manifests) rows.push(['Dependency manifest', c.manifests.length ? c.manifests.join(', ') : 'None']);
    if (c.commits) rows.push(['Commits', `${c.commits.total ?? `${c.commits.sample}+`} · ${c.commits.authors} author(s) · last ${c.commits.daysSinceLast ?? '?'} days ago`]);
    if (c.meta?.fork) rows.push(['Fork', 'Yes — judged as a fork']);
  } else if (e.kind === 'website' || e.kind === 'link') {
    if (c.status != null) rows.push(['HTTP status', c.status]);
    if (c.https != null) rows.push(['HTTPS', yes(c.https)]);
    if (c.responseMs != null) rows.push(['Response time', `${c.responseMs} ms`]);
    if (c.title !== undefined) rows.push(['Title', c.title ?? 'Missing']);
    if (c.metaDescription !== undefined) rows.push(['Meta description', c.metaDescription ? 'Present' : 'Missing']);
    if (c.lang !== undefined) rows.push(['lang attribute', c.lang ?? 'Missing']);
    if (c.images) rows.push(['Images with alt text', c.images.total ? `${c.images.withAlt}/${c.images.total}` : 'No images']);
    if (c.headings) rows.push(['Headings', `${c.headings.h1} h1 · ${c.headings.skippedLevels} skipped level(s)`]);
    if (c.forms) rows.push(['Labelled form fields', c.forms.fields ? `${c.forms.labelled}/${c.forms.fields}` : 'No forms']);
    if (c.brokenLinks) rows.push(['Broken internal links', `${c.brokenLinks.broken} of ${c.brokenLinks.checked} checked`]);
  } else if (e.kind === 'image') {
    if (c.image) rows.push(['Image', `${String(c.image.type).toUpperCase()} · ${c.image.width ?? '?'} × ${c.image.height ?? '?'} px`]);
  } else if (c.text) {
    rows.push(['Extracted text', `${c.text.words} words · ${c.text.headings} headings · ${c.text.listItems} list items`]);
    if (c.pages) rows.push(['Pages', c.pages]);
    if (c.structure) rows.push(['Length', c.structure]);
  }
  if (c.file) rows.push(['File', `${c.file.name} · ${Math.round(c.file.sizeBytes / 1024)} KB`]);
  return (
    <div>
      {rows.length ? <div className="divide-y divide-line/40">{rows.map(([k, v]) => <Row key={k} k={k} v={v} />)}</div> : <p className="text-xs text-fg-muted">No check results yet.</p>}
      {c.note && <p className="mt-2 text-xs text-fg-muted">{c.note}</p>}
      {Array.isArray(c.notes) && c.notes.map((n: string) => <p key={n} className="mt-2 text-xs text-warning">{n}</p>)}
      {c.error && <p className="mt-2 text-xs text-danger-soft">{c.error}</p>}
      <p className="mt-2 text-[11px] text-fg-subtle">Static checks only — Hive Mind never runs submitted code.</p>
    </div>
  );
}

export function ScoreBreakdown({ e }: { e: Evidence }) {
  const s = e.checks?.scoring;
  if (e.qualityScore == null) {
    return <p className="text-xs text-fg-muted">Trust weight {fmtScore(e.trustWeight, 2)}. Points are added once the quality score is in.</p>;
  }
  return (
    <div>
      <p className="font-mono text-sm"><span className="text-fg">{fmtScore(e.qualityScore)}</span> <span className="text-fg-muted">quality ×</span> <span className="text-fg">{fmtScore(e.trustWeight, 2)}</span> <span className="text-fg-muted">trust × 0.8 =</span> <span className="font-semibold text-gold">{fmtScore(e.evidenceScore)}</span> <span className="text-fg-muted">/ 80</span></p>
      {Array.isArray(s?.factors) && <ul className="mt-1 space-y-0.5 text-xs text-fg-muted">{s.factors.map((f: { rule: string; effect: string }) => <li key={f.rule}>{f.rule}: {f.effect}</li>)}</ul>}
    </div>
  );
}

export function ProofItemCard({ e, onChange, canEdit }: { e: Evidence; onChange: () => void; canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const { busy, run } = useAction();
  const st = evidenceStatus(e);
  const Icon = KIND_ICON[e.kind] ?? FileText;
  const urlKind = URL_KINDS.includes(e.kind);
  const methods = e.ownership?.instructions?.methods ?? [];
  const j = e.judgement ?? {};
  return (
    <article className="card card-glow p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line bg-ink-800"><Icon className="h-4 w-4 text-gold" aria-hidden /></div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold">{e.title}</h3>
            <Badge tone={st.tone}>{st.label}</Badge>
            <Badge>{KIND_LABEL[e.kind]}</Badge>
            {urlKind && <Badge tone={e.ownershipStatus === 'verified' ? 'success' : e.ownershipStatus === 'failed' ? 'danger' : 'warning'} icon={<ShieldCheck className="h-3 w-3" />}>
              {e.ownershipStatus === 'verified' ? 'Ownership verified' : e.ownershipStatus === 'failed' ? 'Not verified yet' : 'Verify ownership'}
            </Badge>}
            {e.flags.map((f) => <Badge key={f} tone="danger">{f.replace(/_/g, ' ')}</Badge>)}
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-fg-muted">{e.claim}</p>
          {e.url && <a href={e.url} target="_blank" rel="noopener noreferrer nofollow" className="mt-1 inline-flex max-w-full items-center gap-1 truncate text-xs text-electric-soft hover:underline">{e.url}<ExternalLink className="h-3 w-3 shrink-0" aria-hidden /></a>}
        </div>
        <div className="text-right">
          <div className="text-xl font-semibold text-gold">{e.evidenceScore != null ? fmtScore(e.evidenceScore) : '—'}</div>
          <div className="text-[11px] text-fg-muted">of 80 pts</div>
        </div>
      </div>

      {e.flags.length > 0 && <div className="mt-3 space-y-1">{e.flags.map((f) => <p key={f} className="text-xs text-danger-soft">{FLAG_TEXT[f] ?? f}</p>)}</div>}

      {urlKind && e.ownershipStatus !== 'verified' && methods.length > 0 && (
        <div className="mt-3 rounded-xl border border-line/70 bg-ink-900/60 p-3">
          <p className="text-xs font-medium">Prove you control this {e.kind === 'git_repo' ? 'repository' : 'site'} — verified proof gets up to {e.kind === 'git_repo' ? '1.0' : e.kind === 'website' ? '0.95' : '0.9'} trust instead of {e.kind === 'link' ? '0.4' : '0.5'}.</p>
          <ul className="mt-2 space-y-2">
            {methods.map((m) => (
              <li key={m.key} className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0"><p className="text-xs text-fg-muted">{m.label}</p><code className="block truncate text-[11px] text-fg">{m.value}</code>{m.detail && <p className="text-[11px] text-fg-subtle">{m.detail}</p>}</div>
                <CopyButton value={m.value} />
              </li>
            ))}
          </ul>
          {canEdit && <Button className="mt-3" size="sm" variant="primary" loading={busy === 'verify'} icon={<ShieldCheck className="h-3.5 w-3.5" />}
            onClick={() => run('verify', () => api.post<Evidence & { verification?: { verified: boolean } }>(`/evidence/${e.id}/verify-ownership`), (r) => (r.ownershipStatus === 'verified' ? 'Ownership verified' : 'Token not found yet — check the placement and try again')).then(onChange)}>
            Verify ownership
          </Button>}
          {e.checks?.ownership?.attempts && e.ownershipStatus === 'failed' && (
            <ul className="mt-2 space-y-0.5 text-[11px] text-fg-muted">{e.checks.ownership.attempts.map((a: { method: string; detail: string }) => <li key={a.method}>{a.method}: {a.detail}</li>)}</ul>
          )}
        </div>
      )}

      <button type="button" className="mt-3 inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronDown className={cn('h-3.5 w-3.5 transition', open && 'rotate-180')} aria-hidden />{open ? 'Hide details' : 'Checks, judgement and score breakdown'}
      </button>
      {open && (
        <div className="mt-3 grid gap-4 md:grid-cols-3">
          <div><h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Automated checks</h4><CheckResults e={e} /></div>
          <div>
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Judge</h4>
            {j.status === 'done' ? (
              <>
                <p className="text-sm">Quality <span className="font-semibold">{fmtScore(e.qualityScore)}</span>/100{typeof j.confidence === 'number' && <span className="text-xs text-fg-muted"> · confidence {Math.round(j.confidence * 100)}%</span>}</p>
                {j.rationale && <p className="mt-1 whitespace-pre-wrap text-xs text-fg-muted">{j.rationale}</p>}
                {Array.isArray(j.redFlagsFired) && j.redFlagsFired.length > 0 && <p className="mt-1 text-xs text-danger-soft">Red flags: {j.redFlagsFired.join('; ')}</p>}
                {j.truncation?.truncated && <p className="mt-1 text-[11px] text-fg-subtle">Judged on the first {j.truncation.sentChars.toLocaleString()} of {j.truncation.originalChars.toLocaleString()} characters.</p>}
              </>
            ) : j.status === 'awaiting_judge' ? <p className="text-xs text-fg-muted">Under admin review — no score is guessed in the meantime.</p>
              : j.reason ? <p className="text-xs text-fg-muted">{j.reason}</p> : <p className="text-xs text-fg-muted">{j.error ?? 'Not judged yet.'}</p>}
          </div>
          <div><h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Score</h4><ScoreBreakdown e={e} /><p className="mt-2 text-[11px] text-fg-subtle">Submitted {fmtDateTime(e.createdAt)}</p></div>
        </div>
      )}

      {canEdit && (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-line/50 pt-3">
          <Button size="sm" variant="secondary" loading={busy === 'recheck'} icon={<RefreshCw className="h-3.5 w-3.5" />}
            onClick={() => run('recheck', () => api.post(`/evidence/${e.id}/recheck`), 'Recheck queued').then(onChange)}>Recheck</Button>
          <Button size="sm" variant="ghost" loading={busy === 'delete'} icon={<Trash2 className="h-3.5 w-3.5" />}
            onClick={() => { if (confirm('Delete this proof item?')) void run('delete', () => api.del(`/evidence/${e.id}`), 'Proof deleted').then(onChange); }}>Delete</Button>
        </div>
      )}
      {e.status === 'failed' && !open && e.checks?.error && <Alert tone="warning">{e.checks.error}</Alert>}
    </article>
  );
}
