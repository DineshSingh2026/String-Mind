/**
 * Proof-based evaluation ("Results speak") — mounted at /evidence.
 *
 *   GET    /evidence/rules?domainSlug         scoring table, ownership methods, kind guidance (+ domain guidance)
 *   GET    /evidence?agentId&domainSlug       list proof items (own org)
 *   GET    /evidence/summary?agentId[&domainSlug]   evidence total (≤80) + live check (≤20) per domain
 *   POST   /evidence                          multipart file (pdf|document|image) OR JSON link (git_repo|website|link)
 *   GET    /evidence/:id                      one item (own org) incl. ownership instructions
 *   DELETE /evidence/:id
 *   POST   /evidence/:id/verify-ownership     check the token in the repo / site / DNS
 *   POST   /evidence/:id/recheck              re-run static checks + judge
 *   POST   /evidence/live-checks              { agentId, domainSlug } → live skill check (inbox 24 h or sync job)
 *   GET    /evidence/live-checks?agentId[&domainSlug]
 *   POST   /evidence/live-checks/:id/regrade  re-run the judge on an answered check (e.g. after a judge is configured)
 *
 * Scoring rules: engine/evidence/scoring.ts. Nothing submitted is ever executed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, ne } from 'drizzle-orm';
import { DOMAINS } from '@aix/shared';
import { db, schema } from '../../db/client.js';
import { requirePerm } from '../../lib/auth.js';
import { audit } from '../../lib/audit.js';
import { config } from '../../lib/config.js';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors.js';
import { parse } from '../../lib/http.js';
import { assertSafeUrlForSave } from '../../lib/net-guard.js';
import { getOwnedAgent } from '../../lib/tenancy.js';
import { onTaskAnswered } from '../../lib/agent-inbox.js';
import { enqueue, registerJob } from '../../jobs/queue.js';
import { extractText, removeRaw, resolveMime, storagePathFor } from '../../engine/rag.js';
import { assertAgentActive } from '../owner-controls/service.js';
import { recomputeCertification } from '../certification/service.js';
import { fileHash, imageInfo, IMAGE_MIME, normaliseWebUrl, parseRepoUrl, urlHash } from '../../engine/evidence/checks.js';
import { loadGuidance } from '../../engine/evidence/guidance.js';
import { newOwnershipToken, ownershipInstructions, verifyRepoOwnership, verifyWebsiteOwnership } from '../../engine/evidence/ownership.js';
import {
  agentDomains, createLiveCheck, domainSummary, expireStaleLiveChecks, gradeLiveCheck, onLiveCheckTaskAnswered, processEvidence,
  rescoreDomain, runSyncLiveCheck,
} from '../../engine/evidence/pipeline.js';
import { EVIDENCE_KINDS, FILE_KINDS, scoringRules, URL_KINDS, type EvidenceKind } from '../../engine/evidence/scoring.js';

export const PROCESS_JOB = 'evidence.process';
export const LIVE_JOB = 'evidence.live_check.run';
export const MAX_ITEMS_PER_DOMAIN = 25;
export const FILE_LIMITS: Record<'pdf' | 'document' | 'image', number> = { pdf: 10 * 1024 * 1024, document: 5 * 1024 * 1024, image: 8 * 1024 * 1024 };
const DOC_MIMES = ['text/plain', 'text/markdown', 'text/csv', 'application/json'];
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

const DOMAIN_SLUGS = DOMAINS.map((d) => d.slug) as [string, ...string[]];
const Base = z.object({
  agentId: z.string().uuid(),
  domainSlug: z.enum(DOMAIN_SLUGS),
  kind: z.enum(EVIDENCE_KINDS as [EvidenceKind, ...EvidenceKind[]]),
  title: z.string().trim().min(3).max(200),
  claim: z.string().trim().min(10, 'Describe what this proves (at least 10 characters)').max(1000),
});
const LinkBody = Base.extend({ url: z.string().trim().min(8).max(2000) });
const ListQuery = z.object({ agentId: z.string().uuid().optional(), domainSlug: z.string().max(60).optional() });
const LiveBody = z.object({ agentId: z.string().uuid(), domainSlug: z.enum(DOMAIN_SLUGS) });
const IdParam = z.object({ id: z.string().uuid() });

const rl = (max: number) => ({ config: { rateLimit: { max: config.isTest ? 10_000 : max, timeWindow: '1 minute' } } });

type Evidence = typeof schema.evidenceSubmissions.$inferSelect;
type LiveCheck = typeof schema.evidenceLiveChecks.$inferSelect;

/** Client view: never expose the storage path. */
export function evidenceView(e: Evidence) {
  const { storagePath: _p, ...rest } = e;
  const urlKind = URL_KINDS.includes(e.kind as EvidenceKind);
  return {
    ...rest,
    ownership: urlKind ? { status: e.ownershipStatus, instructions: e.ownershipStatus === 'verified' ? null : ownershipInstructions(e.kind, e.url, e.ownershipToken) } : { status: 'not_applicable', instructions: null },
    flags: Array.isArray(e.checks.flags) ? e.checks.flags : [],
  };
}

/** Client view of a live check: reference solution never shown; rubric only after grading. */
export function liveCheckView(l: LiveCheck) {
  const meta = { ...((l.judgement.meta ?? {}) as Record<string, unknown>) };
  delete meta.referenceSolution;
  const graded = l.status === 'scored' || l.status === 'awaiting_judge' || l.status === 'failed';
  return {
    ...l, rubric: graded ? l.rubric : l.rubric.map((r) => ({ id: r.id, criterion: r.criterion, points: r.points })),
    judgement: { ...l.judgement, meta }, contribution: l.score != null ? Math.round(l.score * 0.2 * 100) / 100 : null,
  };
}

async function ownEvidence(id: string, orgId: string) {
  const [e] = await db().select().from(schema.evidenceSubmissions)
    .where(and(eq(schema.evidenceSubmissions.id, id), eq(schema.evidenceSubmissions.orgId, orgId))).limit(1);
  if (!e) throw notFound('Proof item');
  return e;
}

interface Upload { fields: Record<string, string>; file: { filename: string; mimetype: string; buf: Buffer } | null }

async function readMultipart(req: FastifyRequest): Promise<Upload> {
  const fields: Record<string, string> = {};
  let file: Upload['file'] = null;
  for await (const part of req.parts()) {
    if (part.type === 'file') {
      if (file) { await part.toBuffer().catch(() => undefined); throw badRequest('Upload one file per proof item'); }
      let buf: Buffer;
      try { buf = await part.toBuffer(); } catch { throw unprocessable('File too large (max 20 MB per upload)'); }
      file = { filename: part.filename ?? 'upload', mimetype: part.mimetype, buf };
    } else if (typeof part.value === 'string') {
      fields[part.fieldname] = part.value;
    }
  }
  return { fields, file };
}

/** Validate a file for its kind; returns mime + metadata (throws 422 with a clear message). */
function validateFile(kind: 'pdf' | 'document' | 'image', f: NonNullable<Upload['file']>) {
  const limit = FILE_LIMITS[kind];
  if (!f.buf.length) throw unprocessable('The uploaded file is empty');
  if (f.buf.length > limit) throw unprocessable(`File too large for ${kind}: max ${Math.round(limit / 1024 / 1024)} MB`);
  if (kind === 'image') {
    const info = imageInfo(f.buf);
    if (!info || !IMAGE_EXT.includes(extname(f.filename).toLowerCase())) throw unprocessable('Unsupported image. Supported: .png, .jpg, .jpeg, .gif, .webp (SVG is not accepted)');
    return { mime: IMAGE_MIME[info.type], meta: { image: info } };
  }
  const mime = resolveMime(f.filename, f.mimetype);
  if (kind === 'pdf') {
    if (mime !== 'application/pdf' || f.buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw unprocessable('This is not a PDF file');
  } else if (!mime || !DOC_MIMES.includes(mime)) {
    throw unprocessable('Unsupported document type. Supported: .txt, .md, .csv, .json (convert Word/other formats to PDF or Markdown)');
  }
  let text: string;
  try { text = extractText(f.buf, mime!); } catch {
    throw unprocessable(kind === 'pdf'
      ? 'We could not extract text from this PDF (scanned image or unusual encoding). Upload a text-based PDF, or a .md/.txt export of the document.'
      : 'The document could not be read as UTF-8 text');
  }
  if (text.trim().length < 50) throw unprocessable('The document contains too little text to evaluate (min 50 characters)');
  return { mime: mime!, meta: { textChars: text.length } };
}

async function duplicateInfo(hash: string, orgId: string, agentId: string, domainSlug: string) {
  const same = await db().select({ id: schema.evidenceSubmissions.id, orgId: schema.evidenceSubmissions.orgId, agentId: schema.evidenceSubmissions.agentId, domainSlug: schema.evidenceSubmissions.domainSlug })
    .from(schema.evidenceSubmissions).where(and(eq(schema.evidenceSubmissions.sha256, hash), ne(schema.evidenceSubmissions.moderation, 'removed')));
  if (same.some((s) => s.orgId === orgId && s.agentId === agentId && s.domainSlug === domainSlug)) {
    throw conflict('This proof (same file or URL) is already submitted for this agent and domain');
  }
  const otherOrgs = new Set(same.filter((s) => s.orgId !== orgId).map((s) => s.orgId));
  return { possibleCopy: otherOrgs.size > 0, otherOrganisations: otherOrgs.size, checkedAt: new Date().toISOString() };
}

export default async function routes(app: FastifyInstance) {
  app.get('/rules', async (req) => {
    requirePerm(req, 'agents.read');
    const q = parse(z.object({ domainSlug: z.string().max(60).optional() }), req.query);
    const guidance = q.domainSlug ? await loadGuidance(q.domainSlug) : null;
    return {
      scoring: scoringRules(),
      limits: { fileBytes: FILE_LIMITS, claimMaxChars: 1000, maxItemsPerDomain: MAX_ITEMS_PER_DOMAIN, documentTypes: ['.txt', '.md', '.csv', '.json'], imageTypes: IMAGE_EXT },
      kinds: {
        git_repo: 'Public GitHub or GitLab repository. Verify ownership by committing HIVE_MIND.txt with your token. We read metadata, file tree, README, manifests and a few source files — code is never run.',
        website: 'A live site the agent built or runs. Verify ownership with a meta tag, a /.well-known/hive-mind.txt file or a DNS TXT record. We check reachability, HTTPS, speed, accessibility signals and a sample of internal links.',
        link: 'Any other public page showing the work (article, report, listing). Same ownership methods as a website; lower base trust.',
        pdf: 'Text-based PDF (reports, analyses, case studies). Text is extracted and judged. Ownership cannot be proven for files, so trust is lower.',
        document: 'Markdown, text, CSV or JSON output of the agent. Text is judged. Ownership cannot be proven, so trust is lower.',
        image: 'Screenshot or image. No OCR/vision is available: only type and dimensions are recorded and images add no points on their own.',
      },
      guidance: guidance ? { proofTypes: guidance.proofTypes, authenticityChecks: guidance.authenticityChecks, trustHints: guidance.trustHints, hasRubric: guidance.rubric.length > 0, liveSkillChecks: guidance.liveSkillChecks.length } : null,
    };
  });

  app.get('/', async (req) => {
    const a = requirePerm(req, 'agents.read');
    const q = parse(ListQuery, req.query);
    const conds = [eq(schema.evidenceSubmissions.orgId, a.orgId)];
    if (q.agentId) conds.push(eq(schema.evidenceSubmissions.agentId, q.agentId));
    if (q.domainSlug) conds.push(eq(schema.evidenceSubmissions.domainSlug, q.domainSlug));
    const rows = await db().select().from(schema.evidenceSubmissions).where(and(...conds)).orderBy(desc(schema.evidenceSubmissions.createdAt)).limit(200);
    return { items: rows.map(evidenceView) };
  });

  app.get('/summary', async (req) => {
    const a = requirePerm(req, 'agents.read');
    const q = parse(z.object({ agentId: z.string().uuid(), domainSlug: z.string().max(60).optional() }), req.query);
    await getOwnedAgent(q.agentId, a.orgId);
    await expireStaleLiveChecks(q.agentId);
    const domains = q.domainSlug ? [q.domainSlug] : await agentDomains(q.agentId);
    return { agentId: q.agentId, domains: await Promise.all(domains.map((d) => domainSummary(q.agentId, d))) };
  });

  app.post('/', rl(20), async (req, reply) => {
    const a = requirePerm(req, 'agents.update');
    let body: z.infer<typeof Base> & { url?: string };
    let upload: Upload['file'] = null;
    if (req.isMultipart()) {
      const m = await readMultipart(req);
      body = parse(Base, m.fields);
      upload = m.file;
      if (!FILE_KINDS.includes(body.kind)) throw badRequest(`Kind "${body.kind}" is a link — send JSON with a url instead of a file`);
      if (!upload) throw badRequest('No file uploaded');
    } else {
      body = parse(LinkBody, req.body);
      if (!URL_KINDS.includes(body.kind)) throw badRequest(`Kind "${body.kind}" needs a file upload (multipart/form-data)`);
    }
    const agent = await getOwnedAgent(body.agentId, a.orgId);
    await assertAgentActive(agent.id);
    const existing = await db().select({ id: schema.evidenceSubmissions.id }).from(schema.evidenceSubmissions).where(and(
      eq(schema.evidenceSubmissions.agentId, agent.id), eq(schema.evidenceSubmissions.domainSlug, body.domainSlug)));
    if (existing.length >= MAX_ITEMS_PER_DOMAIN) throw unprocessable(`At most ${MAX_ITEMS_PER_DOMAIN} proof items per agent and domain — delete weaker ones first`);

    let url: string | null = null;
    let hash: string;
    let fileMeta: Record<string, unknown> | null = null;
    let mime: string | null = null;
    if (upload) {
      const v = validateFile(body.kind as 'pdf' | 'document' | 'image', upload);
      mime = v.mime;
      hash = fileHash(upload.buf);
      fileMeta = { name: upload.filename.slice(0, 200), mimeType: v.mime, sizeBytes: upload.buf.length, sha256: hash, ...v.meta };
    } else {
      if (body.kind === 'git_repo') {
        const ref = parseRepoUrl(body.url!);
        if (!ref) throw unprocessable('Enter a public GitHub or GitLab repository URL, e.g. https://github.com/owner/repo');
        url = ref.canonical;
      } else {
        url = normaliseWebUrl(body.url!);
        if (!url) throw unprocessable('Enter a valid http(s) URL (no credentials in the URL)');
      }
      await assertSafeUrlForSave(url, 'Proof URL');
      hash = urlHash(url);
    }
    const duplicate = await duplicateInfo(hash, a.orgId, agent.id, body.domainSlug);
    const urlKind = URL_KINDS.includes(body.kind);
    const [row] = await db().insert(schema.evidenceSubmissions).values({
      agentId: agent.id, orgId: a.orgId, submittedBy: a.user.id, domainSlug: body.domainSlug, kind: body.kind, title: body.title, claim: body.claim,
      url, mimeType: mime, sizeBytes: upload?.buf.length ?? null, sha256: hash,
      ownershipToken: urlKind ? newOwnershipToken() : null, ownershipStatus: urlKind ? 'pending' : 'not_applicable',
      status: 'submitted', checks: { duplicate, ...(fileMeta ? { file: fileMeta } : {}) },
    }).returning();
    let e = row!;
    if (upload) {
      const path = storagePathFor(a.orgId, `evidence-${e.id}`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, upload.buf);
      [e] = await db().update(schema.evidenceSubmissions).set({ storagePath: path }).where(eq(schema.evidenceSubmissions.id, e.id)).returning() as [Evidence];
    }
    await audit({ action: 'evidence.submit', targetType: 'evidence', targetId: e.id, metadata: { agentId: agent.id, kind: body.kind, domainSlug: body.domainSlug, possibleCopy: duplicate.possibleCopy } }, req);
    await enqueue(PROCESS_JOB, { evidenceId: e.id });
    return reply.status(201).send(evidenceView(e));
  });

  app.get('/live-checks', async (req) => {
    const a = requirePerm(req, 'agents.read');
    const q = parse(z.object({ agentId: z.string().uuid(), domainSlug: z.string().max(60).optional() }), req.query);
    await getOwnedAgent(q.agentId, a.orgId);
    await expireStaleLiveChecks(q.agentId);
    const conds = [eq(schema.evidenceLiveChecks.orgId, a.orgId), eq(schema.evidenceLiveChecks.agentId, q.agentId)];
    if (q.domainSlug) conds.push(eq(schema.evidenceLiveChecks.domainSlug, q.domainSlug));
    const rows = await db().select().from(schema.evidenceLiveChecks).where(and(...conds)).orderBy(desc(schema.evidenceLiveChecks.createdAt)).limit(50);
    return { items: rows.map(liveCheckView) };
  });

  app.post('/live-checks', rl(6), async (req, reply) => {
    const a = requirePerm(req, 'agents.update');
    const body = parse(LiveBody, req.body);
    const agent = await getOwnedAgent(body.agentId, a.orgId);
    await assertAgentActive(agent.id);
    const l = await createLiveCheck({ agentId: agent.id, orgId: a.orgId, domainSlug: body.domainSlug },
      async (id) => { await enqueue(LIVE_JOB, { liveCheckId: id }, { maxAttempts: 1 }); });
    await audit({ action: 'evidence.live_check.create', targetType: 'evidence_live_check', targetId: l.id, metadata: { agentId: agent.id, domainSlug: body.domainSlug } }, req);
    return reply.status(201).send(liveCheckView(l));
  });

  app.post('/live-checks/:id/regrade', rl(10), async (req) => {
    const a = requirePerm(req, 'agents.update');
    const { id } = parse(IdParam, req.params);
    const [l] = await db().select().from(schema.evidenceLiveChecks).where(and(eq(schema.evidenceLiveChecks.id, id), eq(schema.evidenceLiveChecks.orgId, a.orgId))).limit(1);
    if (!l) throw notFound('Live check');
    if (l.answer == null || !['awaiting_judge', 'failed', 'answered'].includes(l.status)) throw conflict('Only answered checks that are awaiting judgement or failed grading can be regraded');
    if (l.status === 'failed') await db().update(schema.evidenceLiveChecks).set({ status: 'awaiting_judge' }).where(eq(schema.evidenceLiveChecks.id, id));
    await gradeLiveCheck(id);
    const [after] = await db().select().from(schema.evidenceLiveChecks).where(eq(schema.evidenceLiveChecks.id, id)).limit(1);
    return liveCheckView(after!);
  });

  app.get('/:id', async (req) => {
    const a = requirePerm(req, 'agents.read');
    const { id } = parse(IdParam, req.params);
    return evidenceView(await ownEvidence(id, a.orgId));
  });

  app.delete('/:id', rl(30), async (req) => {
    const a = requirePerm(req, 'agents.update');
    const { id } = parse(IdParam, req.params);
    const e = await ownEvidence(id, a.orgId);
    await db().delete(schema.evidenceSubmissions).where(eq(schema.evidenceSubmissions.id, e.id));
    removeRaw(e.storagePath);
    await rescoreDomain(e.agentId, e.domainSlug);
    try { await recomputeCertification(e.agentId, e.domainSlug); } catch (err) { console.error('[evidence] recompute after delete failed', err); }
    await audit({ action: 'evidence.delete', targetType: 'evidence', targetId: e.id, metadata: { agentId: e.agentId, domainSlug: e.domainSlug } }, req);
    return { ok: true };
  });

  app.post('/:id/verify-ownership', rl(10), async (req) => {
    const a = requirePerm(req, 'agents.update');
    const { id } = parse(IdParam, req.params);
    const e = await ownEvidence(id, a.orgId);
    if (!URL_KINDS.includes(e.kind as EvidenceKind) || !e.url || !e.ownershipToken) throw unprocessable('Ownership verification applies to repositories, websites and links only');
    if (e.ownershipStatus === 'verified') return evidenceView(e);
    const result = e.kind === 'git_repo'
      ? await verifyRepoOwnership(e.url, e.ownershipToken, (e.checks.defaultBranch as string | undefined) ?? null)
      : await verifyWebsiteOwnership(e.url, e.ownershipToken);
    const status = result.verified ? 'verified' : 'failed';
    const [upd] = await db().update(schema.evidenceSubmissions).set({
      ownershipStatus: status, updatedAt: new Date(),
      checks: { ...e.checks, ownership: { status, method: result.method, attempts: result.attempts, checkedAt: new Date().toISOString(), ...(result.verified ? { verifiedAt: new Date().toISOString() } : {}) } },
    }).where(eq(schema.evidenceSubmissions.id, e.id)).returning();
    if (result.verified && e.sha256) {
      // The verifier controls the artifact: other organisations' submissions of the same URL become possible copies.
      const others = await db().select().from(schema.evidenceSubmissions).where(and(eq(schema.evidenceSubmissions.sha256, e.sha256), ne(schema.evidenceSubmissions.orgId, a.orgId)));
      for (const o of others) {
        await db().update(schema.evidenceSubmissions).set({ checks: { ...o.checks, duplicate: { ...((o.checks.duplicate as object) ?? {}), possibleCopy: true, verifiedElsewhere: true } } })
          .where(eq(schema.evidenceSubmissions.id, o.id));
        await rescoreDomain(o.agentId, o.domainSlug);
        try { await recomputeCertification(o.agentId, o.domainSlug); } catch { /* logged by owner feature */ }
      }
    }
    await rescoreDomain(e.agentId, e.domainSlug);
    try { await recomputeCertification(e.agentId, e.domainSlug); } catch (err) { console.error('[evidence] recompute after verify failed', err); }
    await audit({ action: 'evidence.verify_ownership', targetType: 'evidence', targetId: e.id, metadata: { verified: result.verified, method: result.method } }, req);
    const [after] = await db().select().from(schema.evidenceSubmissions).where(eq(schema.evidenceSubmissions.id, upd!.id)).limit(1);
    return { ...evidenceView(after!), verification: result };
  });

  app.post('/:id/recheck', rl(10), async (req) => {
    const a = requirePerm(req, 'agents.update');
    const { id } = parse(IdParam, req.params);
    const e = await ownEvidence(id, a.orgId);
    if (e.moderation === 'removed') throw conflict('This proof item was removed by moderation');
    if (e.status === 'checking' && Date.now() - e.updatedAt.getTime() < 10 * 60_000) throw conflict('Checks are already running for this item');
    await db().update(schema.evidenceSubmissions).set({ status: 'submitted', updatedAt: new Date() }).where(eq(schema.evidenceSubmissions.id, e.id));
    await enqueue(PROCESS_JOB, { evidenceId: e.id });
    await audit({ action: 'evidence.recheck', targetType: 'evidence', targetId: e.id }, req);
    return evidenceView({ ...e, status: 'submitted' });
  });
}

export function registerJobs() {
  registerJob(PROCESS_JOB, async (p) => { if (typeof p.evidenceId === 'string') await processEvidence(p.evidenceId); });
  registerJob(LIVE_JOB, async (p) => { if (typeof p.liveCheckId === 'string') await runSyncLiveCheck(p.liveCheckId); });
  onTaskAnswered('live_check', onLiveCheckTaskAnswered);
}
