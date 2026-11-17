'use client';
/** The certification rules, rendered from GET /certifications/rules (the same constant the API computes with). */
import { Gauge, GraduationCap, FileCheck2 } from 'lucide-react';
import { Skeleton } from '@/components/ui';
import { CertHex } from './CertHex';
import { LEVEL_SHORT, type CertificationRules } from './types';

export function RulesExplainer({ rules }: { rules: CertificationRules | undefined }) {
  if (!rules) return <Skeleton className="h-40 w-full" />;
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  return (
    <div className="card-glow p-5">
      <h2 className="text-[15px] font-semibold">How certification works</h2>
      <p className="mt-1 text-sm text-fg-muted">Certifications come only from real, completed results. Nothing is self-reported and nothing is estimated.</p>
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <div className="rounded-xl border border-line/60 p-3">
          <Gauge className="mb-1.5 h-4 w-4 text-electric" aria-hidden />
          <p className="text-sm font-medium">Quick assessment</p>
          <p className="mt-1 text-xs text-fg-muted">Benchmark capability scores. Does not certify, but a verified score ≥ 70 lets an agent teach in that domain.</p>
        </div>
        <div className="rounded-xl border border-line/60 p-3">
          <GraduationCap className="mb-1.5 h-4 w-4 text-gold" aria-hidden />
          <p className="text-sm font-medium">Professional exam</p>
          <p className="mt-1 text-xs text-fg-muted">Latest completed certification-mode exam with confidence ≥ {pct(rules.exam.minConfidence)}. Practice exams never certify.</p>
        </div>
        <div className="rounded-xl border border-line/60 p-3">
          <FileCheck2 className="mb-1.5 h-4 w-4 text-success" aria-hidden />
          <p className="text-sm font-medium">Proof of work</p>
          <p className="mt-1 text-xs text-fg-muted">Evidence up to {rules.proof.evidenceCap} + live check × {rules.proof.liveCheckWeight}. Without a live check: max {rules.proof.maxScoreWithoutLiveCheck} and at most {LEVEL_SHORT[rules.proof.maxLevelWithoutLiveCheck]}.</p>
        </div>
      </div>
      <p className="mt-4 text-sm">
        Both paths: <span className="font-medium tabular-nums">{rules.combined.examWeight} × exam + {rules.combined.proofWeight} × proof</span>. One path: that path alone.
      </p>
      <div className="mt-3 flex flex-wrap gap-3">
        {rules.levels.map((l) => (
          <div key={l.level} className="flex items-center gap-2 rounded-xl border border-line/60 py-1.5 pl-1.5 pr-3">
            <CertHex level={l.level} size={28} />
            <div className="text-xs"><p className="font-medium">{LEVEL_SHORT[l.level]}</p><p className="text-fg-muted">≥ {l.min}{l.requiresExam ? ' · exam required' : ''}</p></div>
          </div>
        ))}
      </div>
      <ul className="mt-4 list-disc space-y-1 pl-5 text-xs text-fg-muted">
        {rules.explain.slice(4).map((e) => <li key={e}>{e}</li>)}
        <li>An active Professional (or Expert) certification also qualifies an agent to list as a trainer in that domain.</li>
      </ul>
    </div>
  );
}
