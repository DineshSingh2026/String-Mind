/**
 * Local embedding model `aix-hash-256`: deterministic feature-hashing embeddings
 * (unigrams + bigrams, light stemming, stop-word removal, L2-normalised, 256 dims).
 * Works offline with zero cost; good for lexical-semantic retrieval. Production can
 * register a provider embedding model (store with a different `model` value).
 */
import { createHash } from 'node:crypto';
import { EMBEDDING_DIMS } from '../db/schema.js';

export const LOCAL_EMBEDDING_MODEL = 'aix-hash-256';

const STOP = new Set(('a an and are as at be by for from has have how i in is it its of on or that the this to was what when where which who why will with does do did can could should would you your into than then there their them these those about over under per via not no yes if but so such also each any all more most other some what\'s whats').split(' '));

export function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^\p{L}\p{N}%.\s-]/gu, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[-.]+|[-.]+$/g, ''))
    .filter((t) => t && !STOP.has(t))
    .map(stem);
}

function stem(t: string): string {
  if (/^\d/.test(t)) return t;
  return t.replace(/(ies)$/, 'y').replace(/(ing|edly|ed|ly|es|s)$/, '').slice(0, 24) || t;
}

function bucket(feature: string): [number, number] {
  const h = createHash('md5').update(feature).digest();
  return [h.readUInt32LE(0) % EMBEDDING_DIMS, h[4]! & 1 ? 1 : -1];
}

export function embed(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIMS).fill(0);
  const toks = tokenize(text);
  for (let i = 0; i < toks.length; i++) {
    const [d, s] = bucket(toks[i]!);
    v[d]! += s;
    if (i + 1 < toks.length) { const [d2, s2] = bucket(`${toks[i]}_${toks[i + 1]}`); v[d2]! += 0.6 * s2; }
  }
  const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => Math.round((x / n) * 1e6) / 1e6);
}

export function cosine(a: number[], b: number[]): number {
  let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** Jaccard similarity of token 3-shingles — used for leakage / plagiarism detection. */
export function shingleSimilarity(a: string, b: string, k = 3): number {
  const sh = (t: string) => { const x = tokenize(t); const s = new Set<string>(); for (let i = 0; i + k <= x.length; i++) s.add(x.slice(i, i + k).join(' ')); return s; };
  const A = sh(a), B = sh(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Split text into ~maxTokens word chunks on paragraph/sentence boundaries with small overlap. */
export function chunkText(text: string, maxWords = 160, overlapWords = 24): string[] {
  const sentences = text.replace(/\r/g, '').split(/(?<=[.!?])\s+|\n{2,}/).map((s) => s.trim()).filter(Boolean);
  const chunks: string[] = [];
  let cur: string[] = [];
  for (const s of sentences) {
    const words = s.split(/\s+/);
    if (cur.length + words.length > maxWords && cur.length) {
      chunks.push(cur.join(' '));
      cur = cur.slice(-overlapWords);
    }
    cur.push(...words);
  }
  if (cur.length) chunks.push(cur.join(' '));
  return chunks;
}
