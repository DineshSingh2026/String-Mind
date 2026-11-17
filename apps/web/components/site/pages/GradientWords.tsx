'use client';
/** Per-word blur-in where every word carries its own gradient (background-clip text survives the per-word transforms). */
import { motion, useReducedMotion } from 'framer-motion';
import { cx } from '../primitives';

export function GradientWords({ text, tone = 'gold', delay = 0, className }: { text: string; tone?: 'gold' | 'ai'; delay?: number; className?: string }) {
  const reduced = useReducedMotion();
  const words = text.split(/\s+/).filter(Boolean);
  return (
    <span className={className} aria-label={text}>
      {words.map((w, i) => (
        <span key={i} aria-hidden className="inline-block whitespace-pre">
          <motion.span className={cx('inline-block pb-[0.08em]', tone === 'gold' ? 'text-gold-gradient' : 'text-ai-gradient')}
            initial={reduced ? false : { opacity: 0, y: '0.35em', filter: 'blur(10px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            transition={{ duration: 0.8, delay: delay + i * 0.08, ease: [0.2, 0.7, 0.2, 1] }}>
            {w}
          </motion.span>
          {i < words.length - 1 ? ' ' : ''}
        </span>
      ))}
    </span>
  );
}
