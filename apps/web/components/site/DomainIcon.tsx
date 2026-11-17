import {
  Atom, BarChart3, Brain, CandlestickChart, Code2, Compass, Cpu, Globe, GraduationCap, Headset, HeartPulse, Landmark,
  Megaphone, Palette, PenLine, Scale, Search, Shield, Sigma, Workflow, type LucideIcon,
} from 'lucide-react';
import { DOMAINS } from '@aix/shared';

const MAP: Record<string, LucideIcon> = {
  code: Code2, brain: Brain, sigma: Sigma, chart: BarChart3, landmark: Landmark, candlestick: CandlestickChart, compass: Compass,
  megaphone: Megaphone, headset: Headset, pen: PenLine, search: Search, graduation: GraduationCap, atom: Atom, 'heart-pulse': HeartPulse,
  scale: Scale, shield: Shield, palette: Palette, workflow: Workflow, cpu: Cpu, globe: Globe,
};

/** Icon for a capability domain, by icon key or domain slug. */
export function DomainIcon({ icon, slug, className }: { icon?: string; slug?: string; className?: string }) {
  const key = icon ?? DOMAINS.find((d) => d.slug === slug)?.icon ?? 'globe';
  const Icon = MAP[key] ?? Globe;
  return <Icon aria-hidden className={className} />;
}

export const domainName = (slug?: string | null) => (slug ? DOMAINS.find((d) => d.slug === slug)?.name ?? slug : null);
