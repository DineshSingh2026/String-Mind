'use client';
/** Live view of the real role → permission matrix from @aix/shared (ROLE_PERMISSIONS). */
import { useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Check, Minus } from 'lucide-react';
import { ORG_ROLES, roleHas, type Permission } from '@aix/shared';
import { cx } from '../primitives';

const ROWS: [Permission, string][] = [
  ['agents.create', 'Create agents'], ['assessments.run', 'Run assessments'], ['training.respond', 'Accept training'],
  ['marketplace.publish', 'Publish listings'], ['developer.keys.manage', 'Manage API keys'], ['audit.read', 'Read audit log'],
  ['org.members.manage', 'Manage members'], ['wallet.payout', 'Manage org wallet'],
];

export function RbacMatrix() {
  const reduce = useReducedMotion();
  const [hot, setHot] = useState<number | null>(null);
  return (
    <figure className="aix-panel overflow-hidden rounded-[28px]">
      <div className="flex items-center justify-between border-b border-line/50 px-5 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-subtle">Org roles × permissions</p>
        <span className="font-mono text-[10.5px] text-fg-subtle">ROLE_PERMISSIONS</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[460px] text-left text-xs" onMouseLeave={() => setHot(null)}>
          <thead>
            <tr>
              <th scope="col" className="px-4 py-3 font-medium text-fg-subtle"><span className="sr-only">Permission</span></th>
              {ORG_ROLES.map((r, c) => (
                <th key={r} scope="col" onMouseEnter={() => setHot(c)} className={cx('px-1 py-3 text-center font-medium capitalize transition', hot === c ? 'text-gold-soft' : 'text-fg-muted')}>{r}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map(([p, label], ri) => (
              <tr key={p} className="border-t border-line/40">
                <th scope="row" className="whitespace-nowrap px-4 py-2.5 font-normal text-fg-muted">{label}</th>
                {ORG_ROLES.map((r, c) => {
                  const ok = roleHas(r, p);
                  return (
                    <td key={r} onMouseEnter={() => setHot(c)} className={cx('px-1 py-2.5 text-center transition', hot === c && 'bg-gold/[0.05]')}>
                      <motion.span initial={reduce ? false : { scale: 0, opacity: 0 }} whileInView={{ scale: 1, opacity: 1 }} viewport={{ once: true }}
                        transition={{ delay: 0.3 + (ri * ORG_ROLES.length + c) * 0.012, type: 'spring', stiffness: 400, damping: 20 }}
                        className={cx('inline-flex h-5 w-5 items-center justify-center rounded-md', ok ? 'bg-success/15 text-success' : 'text-ink-600')}>
                        {ok ? <Check aria-label="allowed" className="h-3.5 w-3.5" /> : <Minus aria-label="not allowed" className="h-3.5 w-3.5" />}
                      </motion.span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <figcaption className="border-t border-line/50 px-5 py-3 text-xs text-fg-subtle">Rendered from the same permission map the API enforces on every request.</figcaption>
    </figure>
  );
}
