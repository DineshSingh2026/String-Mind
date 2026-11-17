/**
 * Hive Mind Sandbox Agent — an honest, deterministic, offline agent runtime so the platform can be
 * demoed without any provider API keys.
 *
 * It knows NOTHING by itself. It answers only from:
 *   1. the context Hive Mind injects into `req.system` ("Relevant knowledge available to you..." numbered
 *      items built by engine/context.ts from the agent's persistent memories + knowledge sources), and
 *   2. two tiny built-in skills: safe arithmetic evaluation of expressions literally present in the
 *      question, and refusal of clearly harmful requests (keyword safety filter).
 * When no injected item is relevant it abstains ("I don't know …"). Therefore an agent with no
 * knowledge scores low, and after training transfers facts into its memory its score rises for real.
 */
import { performance } from 'node:perf_hooks';
import { cosine, embed, tokenize } from '../engine/embeddings.js';
import type { AgentRuntime, ConnectionInfo, InvokeRequest, InvokeResult } from './types.js';

export const SANDBOX_ABSTAIN = "I don't know — I don't have reliable information on that.";
export const SANDBOX_REFUSAL = "I can't help with that request. It could cause serious harm, so I won't provide it.";

/* ───────────── context parsing ───────────── */

/** Extract numbered knowledge items from the injected system context. */
export function parseContextItems(system: string | undefined): string[] {
  if (!system) return [];
  const idx = system.indexOf('Relevant knowledge available to you');
  if (idx < 0) return [];
  const body = system.slice(idx).split('\n').slice(1);
  const items: string[] = [];
  for (const line of body) {
    const m = /^\[(\d+)\]\s*(.*)$/.exec(line);
    if (m) items.push(m[2]!.replace(/^\([^)]{0,200}\)\s*/, ''));
    else if (items.length && line.trim()) items[items.length - 1] += `\n${line.trim()}`;
  }
  return items.map((s) => s.trim()).filter(Boolean);
}

export function splitSentences(text: string): string[] {
  return text.split(/\n+/)
    .flatMap((line) => line.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/))
    .map((s) => s.replace(/^[-•*]\s*/, '').trim())
    .filter((s) => s.length > 2 && !/^here is what i know/i.test(s));
}

/* ───────────── question parsing ───────────── */

export interface ParsedQuestion { stem: string; choices: { letter: string; text: string }[]; full: string }

export function parseQuestion(text: string): ParsedQuestion {
  const lines = text.split('\n');
  const choices: { letter: string; text: string }[] = [];
  const stemLines: string[] = [];
  for (const line of lines) {
    const m = /^\s*\(?([A-H])[).:]\s+(.+)$/.exec(line);
    if (m) choices.push({ letter: m[1]!, text: m[2]!.trim() });
    else if (!/^\s*(options|choices)\s*:\s*$/i.test(line) && !/^\s*answer concisely\.?\s*$/i.test(line)) stemLines.push(line);
  }
  return { stem: stemLines.join(' ').replace(/\s+/g, ' ').trim(), choices, full: text };
}

const GENERIC = new Set(tokenize(
  'what which following answer concisely only number letter correct best describe describes statement term called name give state explain briefly one word define typical typically used use mean means refer refers known option options true value reply respond tell please choose select',
));

/* ───────────── built-in skill: safety filter ───────────── */

const HARM_ACTION = /\b(how (do|can|could|would|should|might) (i|we|you|one|someone)|how to|step[- ]by[- ]step|instructions? (for|to|on)|write|create|build|make|give me|provide|generate|draft|code|develop|design|help me|teach me|show me|tell me how|explain how to|i want to|i need to|best way to|ways to|recipe for|plan (for|to))\b/i;
const HARM_TARGET: RegExp[] = [
  /\bransomware\b/i, /\bmalware\b/i, /\bkeylogger/i, /\b(computer )?(virus|worm|trojan)\b.*\b(spread|infect|undetect)/i, /\bbotnet\b/i,
  /\bphishing (e-?mails?|pages?|sites?|kits?|messages?|campaigns?|texts?)\b/i, /\bcredential[- ]harvest/i,
  /\b(pipe )?bombs?\b/i, /\bexplosives?\b/i, /\bimprovised explosive\b/i, /\bnerve agents?\b/i, /\b(sarin|ricin|anthrax|vx gas)\b/i, /\b(bio|chemical) ?weapons?\b/i,
  /\b(meth|methamphetamine|fentanyl|heroin|cocaine)\b/i, /\bpoison(ing)?\b/i, /\blethal dose\b/i,
  /\blaunder(ing)?\b.*\bmoney\b/i, /\bmoney[- ]launder/i, /\bcounterfeit\b/i, /\btax evasion\b|\bevade (paying )?tax(es)?\b|\bhide income from\b/i,
  /\binsider (information|tip|tips|trading)\b/i, /\bpump[- ]and[- ]dump\b/i, /\bfront[- ]run/i, /\bmanipulate (the )?(stock|share|market) price/i, /\bspoofing orders\b/i,
  /\bsteal(ing)?\b/i, /\bhack(ing)? into\b/i, /\bbreak into\b/i, /\bddos\b/i, /\bskimm(er|ing)\b/i, /\bcard(ing)? dumps?\b/i,
  /\bforge(d|ry)?\b/i, /\bfake\b.{0,40}\bprescriptions?\b/i, /\bfake (prescriptions?|ids?|passports?|invoices?|reviews?|documents?|certificates?|diplomas?|medical records?)\b/i,
  /\bbypass\b.*\b(authentication|login|paywall|drm|licen[cs]e|2fa|mfa|security)\b/i, /\bdisable\b.*\b(antivirus|security cameras?|alarm)\b/i,
  /\b(kill|murder|hurt|injure|attack)\b.*\b(someone|a person|people|my|him|her|them|neighbou?r|wife|husband|boss)\b/i,
  /\bwithout (their|his|her) (knowledge|consent|permission)\b/i, /\bstalk(ing)?\b/i, /\bdox(x)?(ing)?\b/i,
  /\bself[- ]harm\b/i, /\bsuicide\b/i, /\boverdose\b/i, /\bharass(ment)?\b/i, /\bblackmail\b/i, /\bextort/i,
  /\bwithout (a )?prescription\b/i, /\bplagiari[sz]e\b/i, /\bcheat (on|in) (an |the |my )?(exam|test)\b/i, /\bscam\b/i, /\bponzi\b/i,
  /\bdeepfake\b/i, /\bimpersonat/i, /\bevade (detection|the police|law enforcement)\b/i,
];
const DEFENSIVE = /\b(detect|detection of|prevent|prevention|protect|defend|defen[cs]e|mitigat|recogni[sz]e|identify|avoid|warning signs|signs of|what is an?|define|definition|awareness|train(ing)? (staff|employees))\b/i;

export function isHarmfulRequest(text: string): boolean {
  if (!HARM_ACTION.test(text)) return false;
  if (!HARM_TARGET.some((r) => r.test(text))) return false;
  return !DEFENSIVE.test(text);
}

/* ───────────── built-in skill: safe arithmetic ───────────── */

/** Recursive-descent evaluator for + - * / ^ and parentheses. Returns null on any error. */
export function evalArithmetic(expr: string): number | null {
  const s = expr.replace(/,(?=\d{3}\b)/g, '').replace(/[×x]/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/\s+/g, '');
  if (!/^[\d.+\-*/^()]+$/.test(s)) return null;
  let i = 0;
  const peek = () => s[i];
  function num(): number {
    if (peek() === '(') { i++; const v = add(); if (s[i] !== ')') throw new Error('paren'); i++; return v; }
    if (peek() === '-') { i++; return -num(); }
    const m = /^\d+(\.\d+)?/.exec(s.slice(i));
    if (!m) throw new Error('num');
    i += m[0].length;
    return Number(m[0]);
  }
  function pow(): number { const b = num(); if (peek() === '^') { i++; return b ** pow(); } return b; }
  function mul(): number {
    let v = pow();
    while (peek() === '*' || peek() === '/') { const op = s[i++]; const r = pow(); if (op === '/' && r === 0) throw new Error('div0'); v = op === '*' ? v * r : v / r; }
    return v;
  }
  function add(): number {
    let v = mul();
    while (peek() === '+' || peek() === '-') { const op = s[i++]; const r = mul(); v = op === '+' ? v + r : v - r; }
    return v;
  }
  try {
    const v = add();
    if (i !== s.length || !Number.isFinite(v)) return null;
    return v;
  } catch { return null; }
}

const ARITH_CUE = /\b(calculate|compute|evaluate|what is|what's|how much is|simplify|work out|result of|value of)\b/i;
const EXPR_RE = /[(\s]*-?\d+(?:\.\d+)?(?:\s*[)]*\s*[-+*/×÷^]\s*[(]*\s*-?\d+(?:\.\d+)?\s*[)]*)+/g;

export function formatNumber(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 1e6) / 1e6);
}

/** Returns the numeric answer if the question contains a literal arithmetic task, else null. */
export function tryArithmetic(stem: string): number | null {
  if (!ARITH_CUE.test(stem)) return null;
  const t = stem.replace(/−/g, '-');
  // "X% of Y"
  const pct = /(\d+(?:\.\d+)?)\s*%\s*of\s*(?:an?\s+|the\s+)?(-?\d[\d,]*(?:\.\d+)?)/i.exec(t);
  if (pct) return (Number(pct[1]) / 100) * Number(pct[2]!.replace(/,/g, ''));
  // "square root of N"
  const sq = /square root of\s*(\d+(?:\.\d+)?)/i.exec(t);
  if (sq) return Math.sqrt(Number(sq[1]));
  let best: number | null = null; let bestLen = 0;
  for (const m of t.replace(/(\d),(\d{3})\b/g, '$1$2').matchAll(EXPR_RE)) {
    const raw = m[0].trim();
    if (!/[+*/×÷^]|\s-\s/.test(raw)) continue; // bare hyphens (dates, ranges) are not subtraction
    if (/^\d{4}-\d{2}/.test(raw)) continue;
    let open = 0; for (const ch of raw) { if (ch === '(') open++; else if (ch === ')') open--; }
    const balanced = open > 0 ? raw + ')'.repeat(open) : open < 0 ? '('.repeat(-open) + raw : raw;
    const v = evalArithmetic(balanced);
    if (v !== null && raw.length > bestLen) { best = v; bestLen = raw.length; }
  }
  return best;
}

/* ───────────── retrieval-based answering ───────────── */

const NUMERIC_CUE = /\b(how many|how much|calculate|compute|what percentage|what percent|in what year|which year|what year|how long|how far|how old|how often|only the number|as a number|what (?:is|was) the (?:value|number|total|sum|result|percentage|rate|amount|maximum|minimum|default|standard)|what number|how large|how big|how fast|how high|what size)\b/i;

function properNouns(stem: string): string[] {
  const words = stem.split(/\s+/);
  const out: string[] = [];
  for (let k = 0; k < words.length; k++) {
    const w = words[k]!.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (w.length < 3) continue;
    const prev = k > 0 ? words[k - 1]! : '';
    const sentenceStart = k === 0 || /[.?!:]$/.test(prev);
    if (/^\p{Lu}/u.test(w) && !sentenceStart && !/^\p{Lu}+$/u.test(w)) out.push(...tokenize(w));
  }
  return [...new Set(out)].filter((t) => t.length >= 3 && !GENERIC.has(t));
}

const fold = (t: string) => (t.length > 3 ? t.replace(/e$/, '') : t);

interface Scored { sentence: string; score: number; coverage: number; matched: number }

export function rankSentences(stem: string, items: string[]): Scored[] {
  // drop the possessive "'s" artefact; fold a trailing 'e' so measure/measures, prove/proves match
  const all = [...new Set(tokenize(stem).filter((t) => t !== 's').map(fold))];
  const q = all.filter((t) => !GENERIC.has(t));
  const qTokens = q.length ? q : all;
  const nouns = properNouns(stem);
  const qv = embed(stem);
  const out: Scored[] = [];
  for (const item of items) {
    for (const sentence of splitSentences(item)) {
      const st = new Set(tokenize(sentence).map(fold));
      if (nouns.map(fold).some((n) => !st.has(n))) continue; // named entity not covered → not about this
      const matched = qTokens.filter((t) => st.has(t)).length;
      const coverage = qTokens.length ? matched / qTokens.length : 0;
      const score = 0.65 * coverage + 0.35 * Math.max(0, cosine(qv, embed(sentence)));
      out.push({ sentence, score, coverage, matched });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

function relevant(s: Scored | undefined, qLen: number): s is Scored {
  if (!s) return false;
  return s.coverage >= 0.4 && s.matched >= Math.min(2, Math.max(1, qLen)) && s.score >= 0.33;
}

function numbersIn(text: string): string[] {
  return [...text.replace(/(\d),(\d{3})/g, '$1$2').matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => m[0]);
}

/**
 * Choose the number in `sentence` that answers `stem`: numbers already in the question are skipped;
 * a year is preferred for "what year/when" questions; a number followed by a unit word that the
 * question mentions (e.g. "bits", "days", "%") is preferred; otherwise the first new number.
 */
function pickNumber(sentence: string, stem: string): string | undefined {
  const qNums = new Set(numbersIn(stem));
  const qTok = new Set(tokenize(stem));
  const flat = sentence.replace(/(\d),(\d{3})/g, '$1$2');
  const cands = [...flat.matchAll(/-?\d+(?:\.\d+)?(\s*%)?/g)].map((m) => {
    const after = flat.slice((m.index ?? 0) + m[0].length).trim().split(/\s+/)[0] ?? '';
    const unit = m[1] ? '%' : tokenize(after)[0] ?? '';
    return { n: m[0].replace(/\s*%$/, ''), unit, pct: !!m[1] };
  }).filter((c) => !qNums.has(c.n));
  if (!cands.length) return undefined;
  if (/\b(what|which|in what) year\b|\bwhen (was|were|did)\b/i.test(stem)) {
    const y = cands.find((c) => /^(1[0-9]{3}|20[0-9]{2})$/.test(c.n));
    if (y) return y.n;
  }
  const wantsPct = /\b(percent|percentage|%|rate)\b/i.test(stem);
  const u = cands.find((c) => (c.pct && wantsPct) || (c.unit && c.unit !== '%' && qTok.has(c.unit)));
  return (u ?? cands[0]!).n;
}

function pickChoice(sentence: string, stem: string, choices: { letter: string; text: string }[]): string | null {
  const st = new Set(tokenize(sentence));
  const qt = new Set(tokenize(stem));
  const novel = new Set([...st].filter((t) => !qt.has(t)));
  let best: { letter: string; s: number } | null = null; let tie = false;
  for (const c of choices) {
    const ct = [...new Set(tokenize(c.text))];
    if (!ct.length) continue;
    const phrase = sentence.toLowerCase().replace(/\s+/g, ' ').includes(c.text.toLowerCase().replace(/\s+/g, ' ').replace(/\.$/, '')) ? 0.5 : 0;
    const s = ct.filter((t) => novel.has(t)).length / ct.length + 0.25 * (ct.filter((t) => st.has(t)).length / ct.length) + phrase;
    if (!best || s > best.s + 1e-9) { best = { letter: c.letter, s }; tie = false; }
    else if (Math.abs(s - best.s) < 1e-9) tie = true;
  }
  if (!best || best.s <= 0 || tie) return null;
  return best.letter;
}

const TEACH_CUE = /\b(teach|share|summari[sz]e|key (facts|points|concepts|ideas)|overview|lesson|walk me through|what should i know|everything you know|list the (main|key))\b/i;

/** Pure, deterministic sandbox reasoning step (exported for tests). */
export function sandboxRespond(req: InvokeRequest, persona?: string): string {
  const user = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const q = parseQuestion(user);
  const items = parseContextItems([req.system ?? '', ...req.messages.filter((m) => m.role === 'system').map((m) => m.content)].join('\n'));
  const style = (raw: string) => {
    // strip residue of context-item headers such as "(Title (v1)) " → leading ")"
    const text = raw.replace(/^[\s)\]:;,.\-–—]+/, '').replace(/\n- [\s)\]:;,.\-–—]+/g, '\n- ');
    if (persona === 'friendly') return `Happy to help! ${text}`;
    if (persona === 'formal') return `Based on the reference material available to me: ${text}`;
    return text;
  };

  if (isHarmfulRequest(q.stem)) return SANDBOX_REFUSAL;

  const numberOnly = /\bonly the (\w+ )?(number|numeric value|figure)\b|\bjust the number\b/i.test(user);

  const arith = tryArithmetic(q.stem);
  if (arith !== null && !q.choices.length) return formatNumber(arith);

  const ranked = rankSentences(q.stem, items);
  const qLen = tokenize(q.stem).filter((t) => !GENERIC.has(t)).length;

  // Teaching / summarising request (e.g. a trainer asked to share knowledge): return several facts.
  if (TEACH_CUE.test(q.stem) && !q.choices.length && !q.stem.trim().endsWith('?')) {
    const picked: string[] = [];
    for (const r of ranked) {
      if (r.matched < 1) continue;
      if (!picked.includes(r.sentence)) picked.push(r.sentence);
      if (picked.length >= 6) break;
    }
    if (!picked.length) return SANDBOX_ABSTAIN;
    return style(`Here is what I know that is relevant:\n${picked.map((p) => `- ${p}`).join('\n')}`);
  }

  if (q.choices.length) {
    if (arith !== null) {
      const hit = q.choices.find((c) => numbersIn(c.text).some((n) => Math.abs(Number(n) - arith) < 1e-6));
      if (hit) return hit.letter;
    }
    for (const r of ranked.slice(0, 3)) {
      if (!relevant(r, qLen)) break;
      const letter = pickChoice(r.sentence, q.stem, q.choices);
      if (letter) return letter;
    }
    return SANDBOX_ABSTAIN;
  }

  const top = ranked[0];
  if (!relevant(top, qLen)) return SANDBOX_ABSTAIN;

  if (numberOnly || NUMERIC_CUE.test(q.stem)) {
    const n = pickNumber(top.sentence, q.stem) ?? (numberOnly ? numbersIn(top.sentence)[0] : undefined);
    if (n !== undefined) return n;
    if (numberOnly) return SANDBOX_ABSTAIN;
  }
  return style(top.sentence);
}

export function createSandboxRuntime(info: ConnectionInfo): AgentRuntime {
  const persona = typeof info.config?.persona === 'string' ? info.config.persona : undefined;
  return {
    adapter: 'sandbox',
    capabilities: { chat: true, tools: false, streaming: false, fineTuning: false, contextInjection: true },
    async invoke(req: InvokeRequest): Promise<InvokeResult> {
      const t0 = performance.now();
      const text = sandboxRespond(req, persona);
      return {
        text,
        latencyMs: Math.max(1, Math.round(performance.now() - t0)),
        usage: { inputTokens: Math.ceil(((req.system ?? '').length + req.messages.reduce((a, m) => a + m.content.length, 0)) / 4), outputTokens: Math.ceil(text.length / 4) },
        raw: { provider: 'Hive Mind Sandbox Agent', model: info.model || 'aix-sandbox-1' },
      };
    },
    async health() {
      const t0 = performance.now();
      sandboxRespond({ messages: [{ role: 'user', content: 'What is 2 + 2?' }] }, persona);
      return { ok: true, latencyMs: Math.max(1, Math.round(performance.now() - t0)), model: info.model || 'aix-sandbox-1' };
    },
  };
}
