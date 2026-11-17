/**
 * Knowledge ingestion (RAG): text extraction, normalisation + checksum (duplicate / plagiarism
 * detection), raw file storage, chunking and local embeddings.
 *
 * Supported formats: .txt .md .csv .json (exact), .pdf (best-effort: uncompressed or
 * FlateDecode content streams with literal-string text operators; anything else is rejected
 * with 422 rather than silently storing garbage).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { and, eq, inArray, ne, or } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { config } from '../lib/config.js';
import { sha256 } from '../lib/crypto.js';
import { conflict, unprocessable } from '../lib/errors.js';
import { enqueue } from '../jobs/queue.js';
import { chunkText, embed, LOCAL_EMBEDDING_MODEL } from './embeddings.js';

/** Documents whose extracted text exceeds this are chunked/embedded by the `knowledge.ingest` job. */
export const INLINE_INGEST_MAX_BYTES = 50 * 1024;

const TEXT_TYPES: Record<string, string> = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown',
  '.csv': 'text/csv', '.json': 'application/json', '.pdf': 'application/pdf',
};

export function normaliseText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t\f\v]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** sha256 of case/whitespace-normalised text. */
export function checksumText(text: string): string {
  return sha256(text.toLowerCase().replace(/\s+/g, ' ').trim());
}

/** Resolve the mime type from filename / declared mimetype. Returns null if unsupported. */
export function resolveMime(filename: string | undefined, declared?: string): string | null {
  const ext = extname(filename ?? '').toLowerCase();
  if (TEXT_TYPES[ext]) return TEXT_TYPES[ext]!;
  if (declared && Object.values(TEXT_TYPES).includes(declared)) return declared;
  return null;
}

/** Extract plain text from a supported file. Throws 422 when the content cannot be read reliably. */
export function extractText(buffer: Buffer, mimeType: string): string {
  if (mimeType === 'application/pdf') return extractPdfText(buffer);
  const text = buffer.toString('utf8');
  if (text.includes('\u0000')) throw unprocessable('File does not look like UTF-8 text');
  if (mimeType === 'application/json') {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { throw unprocessable('Invalid JSON file'); }
  }
  return text;
}

/* ───────────── best-effort PDF text extraction (no dependencies) ───────────── */

function decodePdfString(s: string): string {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_m, g: string) => {
    const map: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '', f: '', '(': '(', ')': ')', '\\': '\\' };
    return map[g] ?? String.fromCharCode(parseInt(g, 8));
  });
}

function textFromContentStream(content: string): string {
  const out: string[] = [];
  const blocks = content.match(/BT[\s\S]*?ET/g) ?? [];
  for (const b of blocks) {
    const line: string[] = [];
    const re = /\((?:\\.|[^\\)])*\)\s*(?:Tj|'|")|\[(?:[^\]]*)\]\s*TJ|T\*|Td|TD/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(b))) {
      const tok = m[0];
      if (tok === 'T*' || tok === 'Td' || tok === 'TD') { line.push(' '); continue; }
      const strs = tok.match(/\((?:\\.|[^\\)])*\)/g) ?? [];
      line.push(strs.map((x) => decodePdfString(x.slice(1, -1))).join(''));
    }
    out.push(line.join('').replace(/\s+/g, ' ').trim());
  }
  return out.filter(Boolean).join('\n');
}

export function extractPdfText(buffer: Buffer): string {
  const fail = () => unprocessable('PDF text extraction unavailable; upload text/markdown');
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw fail();
  const raw = buffer.toString('latin1');
  const parts: string[] = [];
  const re = /<<([\s\S]*?)>>\s*stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const dict = m[1]!;
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    let data = buffer.subarray(start, end);
    if (/\/Filter\s*\[?\s*\/FlateDecode/.test(dict)) {
      try { data = inflateSync(data); } catch { continue; }
    } else if (/\/Filter/.test(dict)) continue; // other filters unsupported
    const t = textFromContentStream(data.toString('latin1'));
    if (t) parts.push(t);
    re.lastIndex = end;
  }
  const text = parts.join('\n\n');
  const letters = (text.match(/[A-Za-z]/g) ?? []).length;
  const printable = (text.match(/[\x20-\x7E\n]/g) ?? []).length;
  const words = text.split(/\s+/).filter((w) => /^[A-Za-z][a-z]{1,}$/.test(w)).length;
  if (text.length < 40 || printable / text.length < 0.9 || letters / text.length < 0.5 || words < 5) throw fail();
  return text;
}

/* ───────────── storage ───────────── */

export function storagePathFor(orgId: string, docId: string): string {
  return resolve(process.cwd(), config.STORAGE_DIR, orgId, docId);
}

function writeRaw(path: string, data: Buffer) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

export function removeRaw(path: string | null | undefined) {
  if (!path) return;
  try { rmSync(path, { force: true }); } catch { /* best effort */ }
}

/* ───────────── documents ───────────── */

export interface CreateDocumentInput {
  source: typeof schema.knowledgeSources.$inferSelect;
  title: string;
  mimeType: string;
  /** raw bytes as uploaded (stored as-is) */
  raw: Buffer;
  /** already extracted text */
  text: string;
  uploadedBy?: string;
}

/**
 * Create a document: duplicate detection, raw storage, then inline ingestion for small docs or a
 * `knowledge.ingest` job for large ones. Throws 409 on duplicates (and records a fraud flag when the
 * same content already exists in another organisation).
 */
export async function createDocument(input: CreateDocumentInput) {
  const text = normaliseText(input.text);
  if (!text) throw unprocessable('Document contains no text');
  const checksum = checksumText(text);
  const dupes = await db().select({ id: schema.knowledgeDocuments.id, orgId: schema.knowledgeDocuments.orgId, sourceId: schema.knowledgeDocuments.sourceId })
    .from(schema.knowledgeDocuments).where(and(eq(schema.knowledgeDocuments.checksum, checksum), ne(schema.knowledgeDocuments.status, 'rejected')));
  const sameOrg = dupes.find((d) => d.orgId === input.source.orgId);
  if (sameOrg) throw conflict('This document has already been uploaded to your organisation');
  const otherOrg = dupes.find((d) => d.orgId !== input.source.orgId);
  if (otherOrg) {
    await db().insert(schema.fraudFlags).values({
      targetType: 'knowledge_source', targetId: input.source.id, rule: 'duplicate_knowledge', severity: 'medium',
      details: { checksum, uploaderOrgId: input.source.orgId, uploadedBy: input.uploadedBy ?? null, existingDocumentId: otherOrg.id, existingOrgId: otherOrg.orgId, title: input.title },
    });
    throw conflict('Identical content already exists on Hive Mind under another owner. The upload was blocked and flagged for review.');
  }

  const [doc] = await db().insert(schema.knowledgeDocuments).values({
    sourceId: input.source.id, orgId: input.source.orgId, title: input.title.slice(0, 300), mimeType: input.mimeType,
    sizeBytes: input.raw.length, checksum, status: 'processing',
  }).returning();
  const path = storagePathFor(input.source.orgId, doc!.id);
  try { writeRaw(path, input.raw); } catch (e) {
    await db().delete(schema.knowledgeDocuments).where(eq(schema.knowledgeDocuments.id, doc!.id));
    throw e;
  }
  await db().update(schema.knowledgeDocuments).set({ storagePath: path }).where(eq(schema.knowledgeDocuments.id, doc!.id));

  if (Buffer.byteLength(text, 'utf8') > INLINE_INGEST_MAX_BYTES) {
    await enqueue('knowledge.ingest', { documentId: doc!.id });
    return (await getDocument(doc!.id))!;
  }
  await indexDocumentText(doc!.id, doc!.orgId, text);
  return (await getDocument(doc!.id))!;
}

export async function getDocument(id: string) {
  const [d] = await db().select().from(schema.knowledgeDocuments).where(eq(schema.knowledgeDocuments.id, id)).limit(1);
  return d ?? null;
}

/** Chunk + embed text for a document; marks it ready (or failed). Idempotent (replaces chunks). */
export async function indexDocumentText(documentId: string, orgId: string, text: string) {
  try {
    const chunks = chunkText(text);
    await db().transaction(async (tx) => {
      await tx.delete(schema.knowledgeChunks).where(eq(schema.knowledgeChunks.documentId, documentId));
      for (let i = 0; i < chunks.length; i += 100) {
        const slice = chunks.slice(i, i + 100);
        const rows = await tx.insert(schema.knowledgeChunks).values(slice.map((content, j) => ({
          documentId, orgId, ordinal: i + j, content, tokenCount: content.split(/\s+/).length,
          fingerprint: checksumText(content).slice(0, 16),
        }))).returning({ id: schema.knowledgeChunks.id, content: schema.knowledgeChunks.content });
        await tx.insert(schema.embeddings).values(rows.map((r) => ({ chunkId: r.id, orgId, model: LOCAL_EMBEDDING_MODEL, embedding: embed(r.content) })));
      }
      await tx.update(schema.knowledgeDocuments).set({ status: 'ready', chunkCount: chunks.length, error: null })
        .where(eq(schema.knowledgeDocuments.id, documentId));
    });
  } catch (e) {
    await db().update(schema.knowledgeDocuments).set({ status: 'failed', error: e instanceof Error ? e.message : String(e) })
      .where(eq(schema.knowledgeDocuments.id, documentId));
    throw e;
  }
}

/** Job handler body for `knowledge.ingest` {documentId}. */
export async function ingestDocument(documentId: string) {
  const doc = await getDocument(documentId);
  if (!doc || doc.status === 'ready') return;
  // The raw upload is only needed for this one-off ingestion; chunks + embeddings live in Postgres afterwards.
  // On hosts with an ephemeral disk (e.g. Render without a persistent disk) the file can vanish if the instance
  // restarted between upload and ingestion — fail the document clearly (no pointless retries) and ask for a re-upload.
  if (!doc.storagePath || !existsSync(doc.storagePath)) {
    await db().update(schema.knowledgeDocuments).set({ status: 'failed', error: 'The uploaded file is no longer available on the server (temporary storage was reset before it was processed). Please upload it again.' })
      .where(eq(schema.knowledgeDocuments.id, doc.id));
    return;
  }
  const text = normaliseText(extractText(readFileSync(doc.storagePath), doc.mimeType));
  await indexDocumentText(doc.id, doc.orgId, text);
}

/** Delete a document, its stored file, chunks and embeddings (FK cascade). */
export async function deleteDocument(doc: typeof schema.knowledgeDocuments.$inferSelect) {
  await db().delete(schema.knowledgeDocuments).where(eq(schema.knowledgeDocuments.id, doc.id));
  removeRaw(doc.storagePath);
}

/* ───────────── access control ───────────── */

/** Knowledge sources an org may read: its own sources, sources licensed via the Knowledge Exchange, and public sources. */
export async function orgAccessibleSourceIds(orgId: string): Promise<string[]> {
  const own = await db().select({ id: schema.knowledgeSources.id }).from(schema.knowledgeSources)
    .where(or(eq(schema.knowledgeSources.orgId, orgId), eq(schema.knowledgeSources.visibility, 'public')));
  const licensed = await db().select({ id: schema.knowledgeListings.sourceId }).from(schema.knowledgeLicences)
    .innerJoin(schema.knowledgeListings, eq(schema.knowledgeListings.id, schema.knowledgeLicences.listingId))
    .where(eq(schema.knowledgeLicences.buyerOrgId, orgId));
  return [...new Set([...own.map((r) => r.id), ...licensed.map((r) => r.id)])];
}

export async function sourcesByIds(ids: string[]) {
  if (!ids.length) return [];
  return db().select().from(schema.knowledgeSources).where(inArray(schema.knowledgeSources.id, ids));
}
