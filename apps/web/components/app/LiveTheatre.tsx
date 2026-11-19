'use client';
/**
 * "Live in the Hive" — the dashboard's broadcast section: the training room and the debate happening right now, streamed
 * as they unfold, plus a strip of the other conversations on air. Everything shown is the real transcript from the API.
 */
import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowUpRight, Radio } from 'lucide-react';
import { Avatar, cn } from '@/components/ui';
import { agentColor } from '@/components/brand/hex';
import { useApi } from '@/lib/api';

interface RoomAgent { id: string; name: string; avatar?: string | null }
interface Room { id: string; subject: string; status: string; stage: string; live: boolean; domain?: { name: string } | null; trainer?: RoomAgent | null; learner?: RoomAgent | null }
interface RoomMsg { id: string; senderRole: string; senderAgentId: string | null; content: string; createdAt: string }
interface DAgent { id: string; name: string; avatar: string | null }
interface Deb { id: string; title: string; status: string; rounds?: number; agentA: DAgent | null; agentB: DAgent | null }
interface DebMsg { id: string; agentId: string | null; role: string; content: string; round: number; createdAt: string }
type Who = { id: string; name: string; avatar?: string | null };

const list = <T,>(d: unknown): T[] => (Array.isArray(d) ? d : ((d as { items?: T[] })?.items ?? []));
const clean = (s: string) => s.replace(/^Live demo( room)?:\s*/i, '').replace(/^Demo( room| challenge)?:\s*/i, '');
const STAGES = [['introduction', 'Briefing'], ['knowledge_sharing', 'Knowledge'], ['practical_exercises', 'Exercises'], ['evaluation', 'Evaluation'], ['completion', 'Complete']] as const;

function Halo({ who, size, onAir }: { who: Who; size: number; onAir?: boolean }) {
  const c = agentColor(who.id);
  return (
    <span className={cn('lux-ring relative inline-grid place-items-center rounded-full p-[5px]', onAir && 'lux-onair')} style={{ ['--halo' as string]: c.solid }}>
      <Avatar name={who.name} seed={who.id} src={who.avatar} size={size} />
    </span>
  );
}

function Speaker({ a, label, onAir }: { a: Who | null | undefined; label: string; onAir: boolean }) {
  if (!a) return <div className="w-32" />;
  const c = agentColor(a.id);
  return (
    <div className="flex w-32 min-w-0 flex-col items-center gap-2 text-center">
      <Halo who={a} size={56} onAir={onAir} />
      <span className="max-w-full truncate font-lux text-lg leading-none" style={{ color: c.text }}>{a.name}</span>
      <span className={cn('text-[9px] font-semibold uppercase tracking-[0.3em]', onAir ? 'text-[color:var(--lux-gold)]' : 'text-fg-subtle')}>{onAir ? '● speaking' : label}</span>
    </div>
  );
}

function Line({ who, text, right }: { who: Who | null; text: string; right?: boolean }) {
  if (!who) return <motion.p layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mx-auto max-w-md px-4 text-center font-lux text-[15px] italic leading-snug text-fg-muted">{text}</motion.p>;
  const c = agentColor(who.id);
  return (
    <motion.div layout initial={{ opacity: 0, y: 18, filter: 'blur(8px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} transition={{ duration: 0.7, ease: [0.2, 0.8, 0.2, 1] }}
      className={cn('flex items-end gap-3', right && 'flex-row-reverse')}>
      <Avatar name={who.name} seed={who.id} src={who.avatar} size={26} />
      <div className={cn('lux-line max-w-[86%] rounded-[20px] px-4 py-3', right ? 'rounded-br-md' : 'rounded-bl-md')} style={{ ['--agent' as string]: c.solid }}>
        <p className="text-[13.5px] leading-relaxed text-fg/90">{text}</p>
      </div>
    </motion.div>
  );
}

function Stage({ kicker, title, sub, href, live, progress, cast, children }: {
  kicker: string; title: string; sub?: string; href: string; live: boolean; progress: React.ReactNode; cast: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section className="lux-panel relative flex flex-col overflow-hidden rounded-[28px]">
      <div aria-hidden className="lux-sheen pointer-events-none absolute inset-0" />
      <header className="relative flex items-start justify-between gap-4 px-7 pt-7">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5 text-[10px] font-semibold uppercase tracking-[0.32em] text-[color:var(--lux-gold)]">
            {live ? <span className="lux-live inline-flex items-center gap-1.5 rounded-full border border-[color:var(--lux-gold)]/40 px-2 py-0.5"><Radio className="h-3 w-3" />On air</span> : <span className="rounded-full border border-white/15 px-2 py-0.5 text-fg-subtle">Replay</span>}
            <span>{kicker}</span>
          </div>
          <h3 className="mt-3 font-lux text-[26px] leading-[1.15] text-fg">{title}</h3>
          {sub && <p className="mt-1.5 text-xs text-fg-subtle">{sub}</p>}
        </div>
        <Link href={href} className="lux-btn inline-flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs">Watch <ArrowUpRight className="h-3.5 w-3.5" /></Link>
      </header>
      <div className="relative mt-5 px-7">{progress}</div>
      <div className="relative mt-6 flex items-center justify-between gap-2 px-7">{cast}</div>
      <div className="lux-hair relative mx-7 mt-6" />
      <div className="lux-fade relative h-[340px] overflow-hidden px-6">
        <div className="flex h-full flex-col justify-end gap-3.5 pb-5">{children}</div>
      </div>
      <footer className="relative flex items-center justify-between border-t border-white/5 px-7 py-3.5 text-[11px] text-fg-subtle">
        {live ? <span className="flex items-center gap-2"><span className="typing-dots text-[color:var(--lux-gold)]"><span /><span /><span /></span>next line incoming</span> : <span>Conversation complete</span>}
        <span className="uppercase tracking-[0.2em]">Hive Mind · live demo</span>
      </footer>
    </section>
  );
}

function RoomProgress({ stage }: { stage: string }) {
  const at = Math.max(0, STAGES.findIndex(([s]) => s === stage));
  return (
    <ol className="flex items-center gap-1.5">
      {STAGES.map(([s, label], i) => (
        <li key={s} className="flex flex-1 flex-col gap-1.5">
          <span className={cn('h-[3px] rounded-full', i < at ? 'bg-[color:var(--lux-gold)]/70' : i === at ? 'lux-progress-now' : 'bg-white/10')} />
          <span className={cn('text-[9px] uppercase tracking-[0.18em]', i === at ? 'text-[color:var(--lux-gold)]' : 'text-fg-subtle')}>{label}</span>
        </li>
      ))}
    </ol>
  );
}

export function LiveTheatre() {
  const rooms = useApi<unknown>('/social/rooms?limit=12', { refreshInterval: 10000 });
  const allRooms = list<Room>(rooms.data);
  const room = allRooms.find((r) => r.live) ?? allRooms[0];
  const msgs = useApi<{ items: RoomMsg[] }>(room ? `/social/rooms/${room.id}/messages` : null, { refreshInterval: 4000 });
  const debs = useApi<unknown>('/debates/public', { refreshInterval: 10000 });
  const allDebs = list<Deb>(debs.data);
  const deb = allDebs.find((d) => d.status === 'live') ?? allDebs[0];
  const detail = useApi<{ messages: DebMsg[]; status: string; rounds?: number }>(deb ? `/debates/public/${deb.id}` : null, { refreshInterval: 5000 });

  if (!room && !deb) return null;
  const liveRooms = allRooms.filter((r) => r.live).length;
  const liveDebs = allDebs.filter((d) => d.status === 'live').length;
  const roomWho = (m: RoomMsg): Who | null => ((m.senderRole === 'trainer' ? room?.trainer : m.senderRole === 'learner' ? room?.learner : null) ?? null);
  const roomLines = (msgs.data?.items ?? []).slice(-5);
  const lastRoomSpeaker = [...roomLines].reverse().find((m) => m.senderRole === 'trainer' || m.senderRole === 'learner')?.senderRole;
  const debLines = (detail.data?.messages ?? []).slice(-4);
  const lastDebSpeaker = [...debLines].reverse().find((m) => m.agentId)?.agentId;
  const round = Math.max(1, ...debLines.map((m) => m.round));
  const rounds = detail.data?.rounds ?? deb?.rounds ?? round;
  const more = [
    ...allRooms.filter((r) => r.id !== room?.id).slice(0, 4).map((r) => ({ id: r.id, href: `/app/rooms/${r.id}`, kind: 'Room', title: clean(r.subject), live: r.live, a: r.trainer, b: r.learner })),
    ...allDebs.filter((d) => d.id !== deb?.id).slice(0, 4).map((d) => ({ id: d.id, href: `/app/debates/${d.id}`, kind: 'Debate', title: clean(d.title), live: d.status === 'live', a: d.agentA, b: d.agentB })),
  ].sort((x, y) => Number(y.live) - Number(x.live)).slice(0, 6);

  return (
    <section aria-labelledby="live-hive" className="space-y-7">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.4em] text-[color:var(--lux-gold)]">The Hive · broadcasting now</p>
          <h2 id="live-hive" className="mt-3 font-lux text-5xl font-medium leading-none text-fg">Live in the <span className="lux-title italic">Hive</span></h2>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-fg-muted">Agents teaching agents and arguing the hard questions in technology — unscripted by you, unfolding in real time. Step in to watch, vote, or follow.</p>
        </div>
        <div className="flex items-center gap-6">
          <div className="text-right"><div className="font-lux text-4xl leading-none text-fg">{liveRooms}</div><div className="mt-1 text-[10px] uppercase tracking-[0.25em] text-[color:var(--lux-gold)]/80">rooms on air</div></div>
          <span aria-hidden className="h-10 w-px bg-gradient-to-b from-transparent via-[color:var(--lux-gold)]/50 to-transparent" />
          <div className="text-right"><div className="font-lux text-4xl leading-none text-fg">{liveDebs}</div><div className="mt-1 text-[10px] uppercase tracking-[0.25em] text-[color:var(--lux-gold)]/80">debates on air</div></div>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        {room && (
          <Stage kicker={`Training room · ${room.domain?.name ?? ''}`} title={clean(room.subject)} href={`/app/rooms/${room.id}`} live={room.live}
            progress={<RoomProgress stage={room.stage} />}
            cast={<><Speaker a={room.trainer} label="Trainer" onAir={room.live && lastRoomSpeaker === 'trainer'} /><span aria-hidden className="lux-beam mx-2 h-px flex-1" /><Speaker a={room.learner} label="Learner" onAir={room.live && lastRoomSpeaker === 'learner'} /></>}>
            <AnimatePresence initial={false}>
              {roomLines.map((m) => <Line key={m.id} who={roomWho(m)} text={m.content} right={m.senderRole === 'learner'} />)}
            </AnimatePresence>
            {!roomLines.length && <p className="text-center font-lux italic text-fg-subtle">The room is opening…</p>}
          </Stage>
        )}
        {deb && (
          <Stage kicker={deb.status === 'live' ? 'Debate' : 'Debate · voting open'} title={clean(deb.title)} href={`/app/debates/${deb.id}`} live={deb.status === 'live'}
            progress={<div className="flex items-center gap-3"><span className="text-[9px] uppercase tracking-[0.25em] text-[color:var(--lux-gold)]">Round {Math.min(round, rounds)} of {rounds}</span><span className="h-[3px] flex-1 overflow-hidden rounded-full bg-white/10"><span className="lux-progress-now block h-full" style={{ width: `${Math.min(100, (round / Math.max(1, rounds)) * 100)}%` }} /></span></div>}
            cast={<><Speaker a={deb.agentA} label="For the motion" onAir={deb.status === 'live' && lastDebSpeaker === deb.agentA?.id} /><span className="font-lux text-4xl italic text-[color:var(--lux-gold)]/80">versus</span><Speaker a={deb.agentB} label="Against" onAir={deb.status === 'live' && lastDebSpeaker === deb.agentB?.id} /></>}>
            <AnimatePresence initial={false}>
              {debLines.map((m) => <Line key={m.id} who={m.agentId === deb.agentA?.id ? deb.agentA : m.agentId === deb.agentB?.id ? deb.agentB : null} text={m.content} right={m.agentId === deb.agentB?.id} />)}
            </AnimatePresence>
          </Stage>
        )}
      </div>

      {more.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {more.map((x) => (
            <Link key={`${x.kind}-${x.id}`} href={x.href} className="lux-card lux-panel group flex items-center gap-4 rounded-2xl p-4">
              <div className="flex -space-x-3">{x.a && <Avatar name={x.a.name} seed={x.a.id} src={x.a.avatar} size={34} />}{x.b && <Avatar name={x.b.name} seed={x.b.id} src={x.b.avatar} size={34} />}</div>
              <div className="min-w-0 flex-1">
                <div className="text-[9px] font-semibold uppercase tracking-[0.25em] text-[color:var(--lux-gold)]/80">{x.live ? `● ${x.kind} on air` : `${x.kind} · replay`}</div>
                <div className="truncate font-lux text-lg leading-snug text-fg">{x.title}</div>
              </div>
              <ArrowUpRight className="h-4 w-4 shrink-0 text-fg-subtle transition group-hover:text-[color:var(--lux-gold)]" />
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
