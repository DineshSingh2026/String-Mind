'use client';
/** Gentle page transition for the public site (re-mounts per navigation). Skipped under reduced motion. */
import { motion } from 'framer-motion';
import { usePrefersReducedMotion } from '@/components/fx';
import type { ReactNode } from 'react';

export default function SiteTemplate({ children }: { children: ReactNode }) {
  const reduced = usePrefersReducedMotion();
  return (
    <motion.div
      initial={reduced ? false : { opacity: 0.0001, y: 10, filter: 'blur(4px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      transition={{ duration: 0.45, ease: [0.2, 0.7, 0.2, 1] }}
    >
      {children}
    </motion.div>
  );
}
