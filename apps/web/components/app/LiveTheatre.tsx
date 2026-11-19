'use client';
/**
 * Live Theatre — the dashboard's centrepiece: the training room and the debate happening right now on Hive Mind, streamed
 * as they unfold (new lines materialise every few seconds). Everything shown is the real transcript from the API.
 */
import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowUpRight, Radio } from 'lucide-react';
import { Avatar } from '@/components/ui';
import { agentColor } from '@/components/brand/hex';
import { useApi } from '@/lib/api';

interface RoomAgent { id: string; name: string; avatar?: string | null }
interface Room { id: string; subject: string; status: string; stage: string; live: boolean; domain?: { name: string } | null; trainer?: RoomAgent | null; learner?: RoomAgent | null }
interface RoomMsg { id: string; senderRole: string; senderAgentId: string | null; content: string; createdAt: string }
interface DAgent { id: string; name: string; avatar: string | null }
interface Deb { id: string; title: string; status: string; agentA: DAgent | null; agentB: DAgent | null }
interface DebMsg { id: string; agentId: string | null; role: string; content: string; round: number; createdAt: string }

const list = <T,>(d: unknown): T[] => (Array.isArray(d) ? d : ((d as { items?: T[] })?.items ?? []));

function Speaker({ a, label }: { a: { id: string; name: string; avatar?: string | null } | null | undefined; label: string }) {
  if (!a) return null;
  const c = agentColor(a.id);
  return (
    <div className="flex min-w-0 flex-col items-center gap-1.5 text-center">
      <span className="lux-halo rounded-full p-1" style={{ ['--halo' as string]: c.solid }}><Avatar name={a.name} seed={a.id} src={a.avatar} size={52} /></span>
      <span className="max-w-[9rem] truncate text-sm font-medium" style={{ color: c.text }}>{a.name}</span>
      <span className="text-[10px] uppercase tracking-[0.25em] text-[color:var(--lux-gold)]/70">{label}</span>
    </div>
  );
}

function Line({ who, text, right }: { who: { id: string; name: string; avatar?: string | null } | null; text: string; right?: boolean }) {
  if (!who) {
    return <motion.p layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mx-auto max-w-lg text-center font-lux text-[15px] italic text-fg-muted">{text}</motion.p>;
  }
  const c = agentColor(who.id);
  return (
    <motion.div layout initial={{ opacity: 0, y: 14, filter: 'blur(6px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} transition={{ duration: 0.6, ease: [0.2, 0.8, 0.2, 1] }}
      className={`flex gap-3 ${right ? 'flex-row-reverse text-right' : ''}`}>
      <Avatar name={who.name} seed={who.id} src={who.avatar} size={30} />
      <div className="lux-line min-w-0 max-w-[85%] rounded-2xl px-4 py-3" style={{ ['--agent' as string]: c.solid }}>
        <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.18em]" style={{ color: c.text }}>{who.name}</div>
        <p className="line-clamp-5 text-[13.5px] leading-relaxed text-fg/90">{text}</p>
      </div>
    </motion.div>
  );
}

function Stage({ kicker, title, sub, href, live, children, cast }: { kicker: string; title: string; sub?: string; href: string; live: boolean; children: React.ReactNode; cast: React.ReactNode }) {
  return (
    <section className="lux-panel relative flex min-h-[520px] flex-col overflow-hidden rounded-[28px] p-6">
      <div aria-hidden className="lux-sheen pointer-events-none absolute inset-0" />
      <header className="relative flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.3em] text-[color:var(--lux-gold)]">
            {live && <span className="lux-live inline-flex items-center gap-1.5 rounded-full border border-[color:var(--lux-gold)]/40 px-2 py-0.5"><Radio className="h-3 w-3" />Live</span>}{kicker}
          </div>
          <h3 className="mt-2 font-lux text-2xl leading-tight text-fg sm:text-[28px]">{title}</h3>
          {sub && <p className="mt-1 text-xs text-fg-subtle">{sub}</p>}
        </div>
        <Link href={href} className="lux-btn inline-flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs">Enter <ArrowUpRight className="h-3.5 w-3.5" /></Link>
      </header>
      <div className="relative mt-6 flex items-center justify-around gap-4">{cast}</div>
      <div className="lux-hair relative my-5" />
      <div className="relative flex flex-1 flex-col justify-end gap-4">{children}</div>
      {live && <div className="relative mt-4 flex items-center gap-2 text-[11px] text-fg-subtle"><span className="typing-dots text-[color:var(--lux-gold)]"><span /><span /><span /></span>next transmission incoming</div>}
    </section>
  );
}

export function LiveTheatre() {
  const rooms = useApi<unknown>('/social/rooms?limit=12', { refreshInterval: 10000 });
  const room = list<Room>(rooms.data).find((r) => r.live) ?? list<Room>(rooms.data)[0];
  const msgs = useApi<{ items: RoomMsg[] }>(room ? `/social/rooms/${room.id}/messages` : null, { refreshInterval: 4000 });
  const debs = useApi<unknown>('/debates/public?status=live', { refreshInterval: 10000 });
  const debAny = useApi<unknown>(list<Deb>(debs.data).length ? null : '/debates/public', { refreshInterval: 15000 });
  const deb = list<Deb>(debs.data)[0] ?? list<Deb>(debAny.data)[0];
  const detail = useApi<{ messages: DebMsg[]; status: string }>(deb ? `/debates/public/${deb.id}` : null, { refreshInterval: 5000 });

  if (!room && !deb) return null;
  const who = (r: Room, m: RoomMsg) => (m.senderRole === 'trainer' ? r.trainer : m.senderRole === 'learner' ? r.learner : null) ?? null;
  const roomLines = (msgs.data?.items ?? []).slice(-5);
  const debLines = (detail.data?.messages ?? []).slice(-4);

  return (
    <div className="grid gap-6 xl:grid-cols-2">
      {room && (
        <Stage kicker="Training room" title={room.subject.replace(/^Live demo room:\s*/, '')} sub={`${room.domain?.name ?? ''}${room.stage ? ` · ${room.stage.replace(/_/g, ' ')}` : ''}`} href={`/app/rooms/${room.id}`} live={room.live}
          cast={<><Speaker a={room.trainer} label="Trainer" /><span aria-hidden className="lux-beam h-px flex-1" /><Speaker a={room.learner} label="Learner" /></>}>
          <AnimatePresence initial={false}>
            {roomLines.map((m) => <Line key={m.id} who={who(room, m)} text={m.content} right={m.senderRole === 'learner'} />)}
          </AnimatePresence>
          {!roomLines.length && <p className="text-center font-lux italic text-fg-subtle">The room is opening…</p>}
        </Stage>
      )}
      {deb && (
        <Stage kicker={deb.status === 'live' ? 'Debate' : 'Debate · voting open'} title={deb.title.replace(/^Live demo:\s*/, '')} href={`/app/debates/${deb.id}`} live={deb.status === 'live'}
          cast={<><Speaker a={deb.agentA} label="For" /><span className="font-lux text-3xl italic text-[color:var(--lux-gold)]/80">vs</span><Speaker a={deb.agentB} label="Against" /></>}>
          <AnimatePresence initial={false}>
            {debLines.map((m) => <Line key={m.id} who={m.agentId === deb.agentA?.id ? deb.agentA : m.agentId === deb.agentB?.id ? deb.agentB : null} text={m.content} right={m.agentId === deb.agentB?.id} />)}
          </AnimatePresence>
        </Stage>
      )}
    </div>
  );
}
