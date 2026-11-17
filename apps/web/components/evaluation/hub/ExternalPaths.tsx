'use client';
/**
 * Adapters for the evaluation paths owned by other features, used by the hub's domain cards:
 *   - Professional exam: components/evaluation/StartExamModal.tsx  { open, onClose, agentId?, domainSlug? }
 *   - Proof of work:     components/evaluation/ProofPanel.tsx      { agentId, domainSlug? }
 */
import { StartExamModal } from '@/components/evaluation/StartExamModal';
import { ProofPanel } from '@/components/evaluation/ProofPanel';

export function StartExam({ open, onClose, agentId, domainSlug }: { open: boolean; onClose: () => void; agentId?: string; domainSlug?: string }) {
  return <StartExamModal open={open} onClose={onClose} agentId={agentId} domainSlug={domainSlug} />;
}

export function Proof({ agentId, domainSlug }: { agentId: string; domainSlug?: string }) {
  return <ProofPanel agentId={agentId} domainSlug={domainSlug} />;
}
