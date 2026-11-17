'use client';
import { useState } from 'react';
import { AlertTriangle, Check, Copy } from 'lucide-react';
import { Button, Modal, cn, useToast } from '@/components/ui';

export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4700';

export function useCopy() {
  const toast = useToast();
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (text: string, id = 'x') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id); setTimeout(() => setCopied((c) => (c === id ? null : c)), 1800);
    } catch { toast('danger', 'Clipboard unavailable — select and copy manually'); }
  };
  return { copied, copy };
}

export function CopyButton({ text, label = 'Copy', className }: { text: string; label?: string; className?: string }) {
  const { copied, copy } = useCopy();
  return (
    <Button size="sm" variant="outline" className={className} onClick={() => void copy(text)} aria-label={copied ? 'Copied' : label}
      icon={copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}>{copied ? 'Copied' : label}</Button>
  );
}

export function CodeBlock({ code, lang, title }: { code: string; lang?: string; title?: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-ink-950">
      <div className="flex items-center justify-between gap-2 border-b border-line/70 px-3 py-1.5">
        <span className="font-mono text-[11px] text-fg-subtle">{title ?? lang}</span>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed text-fg"><code>{code}</code></pre>
    </div>
  );
}

/** Shows a secret exactly once. The secret lives only in component state and is dropped on close. */
export function SecretOnceModal({ open, onClose, title, secret, description }: { open: boolean; onClose: () => void; title: string; secret: string | null; description?: string }) {
  const [ack, setAck] = useState(false);
  const close = () => { setAck(false); onClose(); };
  return (
    <Modal open={open} onClose={() => ack && close()} title={title} description={description}
      footer={<Button variant="primary" disabled={!ack} onClick={close}>I&apos;ve stored it safely</Button>}>
      <div className="space-y-4">
        <div className="flex gap-3 rounded-xl border border-warning/40 bg-warning/5 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <p className="text-fg-muted"><strong className="text-fg">This is the only time it will be shown.</strong> StringMind stores only a hash. Keep it in a secret manager — never in frontend code or a git repository.</p>
        </div>
        {secret ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <code className={cn('flex-1 break-all rounded-xl border border-line bg-ink-950 px-3 py-2.5 font-mono text-xs text-gold-soft')}>{secret}</code>
            <CopyButton text={secret} label="Copy secret" />
          </div>
        ) : <p className="text-sm text-danger-soft">The server did not return a secret. Rotate to generate a new one.</p>}
        <label className="flex items-center gap-2 text-sm text-fg-muted">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="h-4 w-4 accent-[rgb(var(--gold))]" />
          I have copied and stored this secret.
        </label>
      </div>
    </Modal>
  );
}

/** Pick the one-time secret out of a create/rotate response without assuming the exact field name. */
export function extractSecret(res: unknown, keys = ['key', 'secret', 'token', 'apiKey', 'plaintext']): string | null {
  if (!res || typeof res !== 'object') return null;
  const o = res as Record<string, unknown>;
  for (const k of keys) if (typeof o[k] === 'string') return o[k] as string;
  for (const k of keys) if (o[k] && typeof o[k] === 'object') { const inner = extractSecret(o[k], keys); if (inner) return inner; }
  return null;
}

export function NoPermission({ perm }: { perm: string }) {
  return <p className="rounded-xl border border-line bg-ink-950/40 px-3 py-2 text-xs text-fg-subtle">Your organisation role doesn&apos;t include <code className="font-mono text-fg-muted">{perm}</code>. Ask an owner or admin.</p>;
}
