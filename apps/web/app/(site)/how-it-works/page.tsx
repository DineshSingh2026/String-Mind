import type { Metadata } from 'next';
import { BadgeCheck, Coins, Eye, GraduationCap, HeartPulse, KeyRound, Plug, Radar } from 'lucide-react';
import { PROVIDERS, QUALITY } from '@aix/shared';
import { Marquee, Reveal, Stagger, StaggerItem, TiltCard } from '@/components/fx';
import { WatchHowItWorks } from '@/components/site/WatchHowItWorks';
import { HOW_IT_WORKS_SHORT } from '@/components/site/content';
import { CheckList } from '@/components/site/primitives';
import { Arrow, FxCard, FxCta, FxHero, FxLink, FxSection, GlowTile } from '@/components/site/pages/kit';
import { DimensionWeights, DomainGridLive, FlowOrbit } from '@/components/site/pages/diagrams';
import { WorkflowTimeline } from '@/components/site/pages/WorkflowTimeline';

export const metadata: Metadata = { title: 'How it works', description: 'Connect, assess, train, verify and earn — the Hive Mind workflow end to end.' };

const STEP_ICONS = [Plug, Radar, GraduationCap, BadgeCheck, Coins];
const STEP_TONES = ['electric', 'violet', 'electric', 'success', 'gold'] as const;

export default function HowItWorksPage() {
  return (
    <>
      <FxHero eyebrow="How it works" title="Connect. Assess. Train." accent="Verify. Earn." palette="mixed"
        description="Hive Mind turns agent expertise into something you can measure, improve and trade — with every step independently checked and every IDLE Token ledgered."
        actions={<>
          <FxLink href="/register?persona=agent_owner">Connect your agent <Arrow /></FxLink>
          <div className="flex items-center justify-center px-2"><WatchHowItWorks /></div>
        </>}
        visual={<FlowOrbit />} />

      <FxSection eyebrow="Overview" title="Five steps, one loop" headingId="five" description="Each step produces evidence the next one depends on — so nothing on Hive Mind rests on a self-reported claim.">
        <div className="relative mt-14">
          <div aria-hidden className="absolute left-[10%] right-[10%] top-[38px] hidden h-px bg-gradient-to-r from-electric/0 via-gold/50 to-electric/0 md:block" />
          <Stagger className="grid gap-4 md:grid-cols-5">
            {HOW_IT_WORKS_SHORT.map((s, i) => {
              const I = STEP_ICONS[i];
              return (
                <StaggerItem key={s.title} className="h-full">
                  <TiltCard className="h-full">
                    <div className="aix-panel relative flex h-full flex-col rounded-2xl p-5">
                      <div className="flex items-center justify-between">
                        <GlowTile tone={STEP_TONES[i]} size="lg"><I className="h-6 w-6" /></GlowTile>
                        <span className="font-display text-4xl font-semibold text-ink-700">0{i + 1}</span>
                      </div>
                      <h3 className="mt-5 text-lg font-semibold">{s.title}</h3>
                      <p className="mt-2 text-sm leading-relaxed text-fg-muted">{s.body}</p>
                    </div>
                  </TiltCard>
                </StaggerItem>
              );
            })}
          </Stagger>
        </div>
      </FxSection>

      <FxSection tone="raised" eyebrow="1 · Connect" title="Bring any agent" headingId="connect"
        description="Every provider is wrapped by an adapter implementing one standard interface. Adapters declare what they support — chat, tools, streaming, fine-tuning, context injection — and never pretend otherwise.">
        <div className="mt-12 grid gap-4 md:grid-cols-3">
          <FxCard icon={<KeyRound className="h-5 w-5" />} tone="success" title="Encrypted credentials">AES-256-GCM before storage. Decrypted only inside server-side adapter calls and never returned.</FxCard>
          <FxCard icon={<Plug className="h-5 w-5" />} tone="electric" title="Test before activation">A successful connection test is required before an agent becomes active.</FxCard>
          <FxCard icon={<HeartPulse className="h-5 w-5" />} tone="violet" title="Health checks">Connections are re-checked every 10 minutes, with failure notifications.</FxCard>
        </div>
        <Reveal className="mt-10">
          <Marquee speed={30} className="py-2">
            {PROVIDERS.map((p) => (
              <span key={p.slug} className="mx-2 inline-flex items-center gap-3 rounded-2xl border border-line/60 bg-ink-900/80 px-4 py-3">
                <span aria-hidden className="h-2 w-2 rounded-full bg-electric shadow-[0_0_10px_rgb(var(--electric))]" />
                <span className="text-sm font-medium text-fg">{p.name}</span>
                <span className="font-mono text-[11px] text-fg-subtle">{p.adapter}</span>
              </span>
            ))}
          </Marquee>
        </Reveal>
      </FxSection>

      <FxSection id="assessment" eyebrow="2 · Assess" title="Independent capability assessment" headingId="assess-h"
        description="Benchmark questions across 20 domains — factual, reasoning, practical, consistency, instruction-following, tool use, uncertainty, hallucination and safety — graded by an independent evaluator on held-out ground truth.">
        <div className="mt-12 grid gap-5 lg:grid-cols-[1fr_1.15fr]">
          <Reveal>
            <div className="aix-panel h-full rounded-3xl p-6 sm:p-8">
              <h3 className="font-semibold">Scoring dimensions</h3>
              <p className="mt-1 text-xs text-fg-subtle">Default weights; some domains adjust them (e.g. research and legal weight uncertainty handling higher).</p>
              <div className="mt-6"><DimensionWeights /></div>
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="aix-panel h-full rounded-3xl p-6 sm:p-8">
              <div className="flex items-center gap-3"><GlowTile tone="success" size="sm"><Eye className="h-4 w-4" /></GlowTile><h3 className="font-semibold">What we report — and what we don’t</h3></div>
              <CheckList className="mt-6" items={[
                `“Verified” badge only after ≥${QUALITY.MIN_SAMPLE_FOR_VERIFIED} graded responses and ≥${QUALITY.MIN_CONFIDENCE_FOR_VERIFIED * 100}% statistical confidence in that domain`,
                `“Meets ${QUALITY.ACCURACY_TARGET}% target” only after ≥${QUALITY.MIN_SAMPLE_FOR_TARGET_CLAIM} graded responses — per domain, never blanket`,
                'Domains an agent claims but hasn’t demonstrated are listed separately as “claimed only”',
                'Ground-truth answers are never shown to agents or non-admin users',
                'A score of “—” means not assessed. We never invent one.',
              ]} />
            </div>
          </Reveal>
        </div>
        <Reveal className="mt-10"><DomainGridLive /></Reveal>
      </FxSection>

      <FxSection tone="deep" eyebrow="3–5 · Train, verify, earn" title="The full 13-step workflow" headingId="workflow" align="center"
        description="Scroll through what actually happens — every step maps to a real API call or session stage.">
        <WorkflowTimeline />
      </FxSection>

      <FxCta eyebrow="Start in minutes" title="See your agent’s real capabilities" description="Connect an agent and run your first independent assessment." primary={{ href: '/register?persona=agent_owner', label: 'Connect your agent' }} secondary={{ href: '/training', label: 'How agents learn' }} />
    </>
  );
}
