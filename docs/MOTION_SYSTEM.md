# Hive Mind Motion & Visual-Effects System (`apps/web/components/fx`)

Import everything from `@/components/fx`. Library: `framer-motion@12` (installed). All effects MUST:
- respect `prefers-reduced-motion` (render static, no loops),
- pause canvas loops when off-screen (IntersectionObserver) or tab hidden (`document.visibilityState`),
- be client components (`'use client'`), SSR-safe (no `window` at module scope), and never block LCP,
- keep 60fps on a mid laptop: DPR capped at 2, ≤ ~400 particles, no layout thrash,
- be data-honest: visuals driven by live API data must show real values only (empty state when 0).

## Contract (exact exports)

| Export | Props | Purpose |
|---|---|---|
| `Reveal` | `{ children, delay?: number, y?: number, className?, as?: 'div'\|'section'\|'li' }` | fade/slide-in on scroll (once) |
| `Stagger` + `StaggerItem` | `{ children, className?, gap?: number }` | staggered children reveal |
| `CountUp` | `{ value: number \| null, decimals?: number, prefix?: string, suffix?: string, duration?: number, className? }` | animates 0→value when visible; `null` renders "—" |
| `SpotlightCard` | `{ children, className?, glow?: 'gold'\|'electric'\|'violet' }` | card with cursor-following radial light + animated border on hover |
| `TiltCard` | `{ children, className?, max?: number }` | subtle 3D tilt toward cursor |
| `MagneticButton` | wraps a child element; `{ children, strength?: number }` | button gently follows cursor |
| `AuroraBackground` | `{ className?, intensity?: 'subtle'\|'normal'\|'vivid', palette?: 'gold'\|'ai'\|'mixed' }` | animated gradient-mesh blobs, absolutely positioned (parent `relative overflow-hidden`) |
| `GridBackground` | `{ className?, fade?: boolean }` | perspective grid with moving scan line |
| `ParticleField` | `{ className?, density?: number, color?: string }` | ambient floating particles canvas |
| `AgentNetwork` | `{ data: NetworkData \| null, className?, interactive?: boolean }` | **data-driven** canvas force graph: one node per real public agent (size ∝ verified score, gold = trainer, blue/violet = other), domain hubs, animated pulses along real training links; hover shows name/score; idle "orbit" when empty |
| `HoloGlobe` | `{ className?, size?: number, points?: { label: string; weight: number }[] }` | canvas 3D rotating wireframe globe with gold orbit rings; `points` drawn as glowing nodes (e.g. domains with verified agents) |
| `DomainConstellation` | `{ domains: ConstellationDomain[], className? }` | 20 domains as stars; brightness/size ∝ verifiedAgents, rings for completedSessions, tooltip with real numbers |
| `LiveTicker` | `{ items: ActivityItem[], className? }` | infinite marquee of real activity ("TaxExpert verified in Financial Analysis · 91.3") — hidden when empty |
| `Marquee` | `{ children, speed?: number, reverse?: boolean, className? }` | generic infinite marquee |
| `TextShimmer` | `{ children, className? }` | gold sheen sweep across text |
| `WordReveal` | `{ text: string, className?, delay?: number }` | per-word blur-in headline |
| `DrawPath` | `{ d: string, className?, stroke?: string, width?: number }` | SVG path that draws itself on scroll |
| `GlowDivider` | `{ className? }` | animated gradient hairline |
| `useNetworkData()` | → `{ data: NetworkData \| null, error, isLoading }` | SWR fetch of `GET /public/network` (refresh 30s) |
| `usePublicStats()` | → `{ data, error, isLoading }` | SWR fetch of `GET /public/stats` (refresh 30s) |

Types (export from `components/fx/types.ts`) — mirror API `GET /public/network`:
```ts
interface NetworkNode { id: string; slug: string; name: string; domains: string[]; score: number | null; role: 'trainer' | 'agent'; sessionsAsTrainer: number }
interface NetworkLink { source: string; target: string; improvement: number | null }
interface ConstellationDomain { slug: string; name: string; icon: string | null; highImpact: boolean; verifiedAgents: number; bestScore: number | null; completedSessions: number; avgImprovement: number | null }
type ActivityItem =
  | { type: 'assessment'; at: string; agent: string; domain: string; score: number | null }
  | { type: 'training'; at: string; agent: string; learner: string; domain: string; improvement: number | null };
interface NetworkData { nodes: NetworkNode[]; links: NetworkLink[]; constellation: ConstellationDomain[]; activity: ActivityItem[]; generatedAt: string }
```

## Art direction
Premium, cinematic, calm — Linear/Vercel/Stripe-level polish in Hive Mind's black–navy–gold palette with electric/violet AI accents. Motion is purposeful (reveals, data pulses), never noisy. Typography: big confident display headlines (Sora), tight tracking, generous whitespace, layered depth (glass, glows, grain). See `docs/DESIGN_REFERENCE.md`.
