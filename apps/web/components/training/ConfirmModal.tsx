'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { Button, Field, Modal, Textarea, useToast } from '@/components/ui';
import { errorMessage } from '@/lib/api';

/**
 * Confirmation dialog for (destructive) mutations. Runs `onConfirm`, toasts success/failure, closes on success.
 * Optionally collects a free-text reason (`reasonLabel`) that is passed to `onConfirm`.
 */
export function ConfirmModal({
  open, onClose, title, description, children, confirmLabel = 'Confirm', tone = 'danger', onConfirm, successMessage,
  reasonLabel, reasonRequired, reasonPlaceholder,
}: {
  open: boolean; onClose: () => void; title: string; description?: ReactNode; children?: ReactNode;
  confirmLabel?: string; tone?: 'danger' | 'primary' | 'ai'; onConfirm: (reason: string) => Promise<unknown>; successMessage?: string;
  reasonLabel?: string; reasonRequired?: boolean; reasonPlaceholder?: string;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  useEffect(() => { if (open) setReason(''); }, [open]);
  const run = async () => {
    setBusy(true);
    try {
      await onConfirm(reason.trim());
      if (successMessage) toast('success', successMessage);
      onClose();
    } catch (e) {
      toast('danger', errorMessage(e));
    } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={busy ? () => undefined : onClose} title={title} description={description} size="sm"
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant={tone} loading={busy} disabled={reasonRequired && !reason.trim()} onClick={run}>{confirmLabel}</Button>
      </>}>
      {children}
      {reasonLabel && (
        <div className={children ? 'mt-4' : ''}>
          <Field label={reasonLabel} required={reasonRequired} htmlFor="confirm-reason">
            <Textarea id="confirm-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={reasonPlaceholder} maxLength={2000} />
          </Field>
        </div>
      )}
      {!children && !reasonLabel && <p className="text-sm text-fg-muted">This action is recorded in the audit log.</p>}
    </Modal>
  );
}
