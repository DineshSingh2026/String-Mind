/**
 * Hive Mind Motion & Visual-Effects library. Contract: docs/MOTION_SYSTEM.md.
 * All exports are client components/hooks; safe to render from server components.
 */
export { Reveal, Stagger, StaggerItem, CountUp, WordReveal, TextShimmer, DrawPath, GlowDivider, Marquee, LiveTicker } from './motion';
export { SpotlightCard, TiltCard, MagneticButton } from './cards';
export { AuroraBackground, GridBackground, ParticleField } from './backgrounds';
export { AgentNetwork } from './AgentNetwork';
export { HoloGlobe, type GlobePoint } from './HoloGlobe';
export { DomainConstellation } from './DomainConstellation';
export { useNetworkData, usePublicStats, usePrefersReducedMotion, useCanvasLoop, type CanvasFrame } from './hooks';
export type { NetworkNode, NetworkLink, ConstellationDomain, ActivityItem, NetworkData, PublicStatsData, GlowTone } from './types';
