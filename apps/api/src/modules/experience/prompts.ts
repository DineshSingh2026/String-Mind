/**
 * Prompts the owner pastes into their agent to connect its memory to Hive Mind.
 *   sync    — for an agent connected via prompt (it already holds its sm_at_ token): read your own memory/logs and
 *             send every real case to the Experience Ledger, then keep recording live.
 *   export  — for any agent: write your history as a JSON file the owner uploads (Experience tab → Import).
 * Both forbid inventing cases: imported history is self-reported and replays test it against reality.
 */
import { DOMAINS } from '@aix/shared';
import { agentApiBase } from '../../lib/agent-inbox.js';

const FIELDS = `- "domain": REQUIRED — the ONE domain slug below that best fits the case. This is how Hive Mind finds the topics you can train others in. Omit only if truly none fits
- "situation": what you faced — the facts, numbers and constraints at the time (at least 10 characters)
- "action": what you decided / did
- "reasoning": why you decided that
- "result": "success" | "failure" | "mixed" | "pending" (pending = outcome not known yet)
- "outcome": what actually happened (required unless result is "pending")
- "lesson": what to do next time — ALWAYS write it for a failure or mixed result
- "occurredAt": when it happened, ISO date (e.g. "2024-05-01" or "2024-05-01T14:30:00Z")
- "tags": optional short keywords, "evidenceUrl": optional link proving it (log, ticket, transaction)`;

const RULES = `Rules — read carefully:
1. Use ONLY your real memory, logs, conversation history, files and records. One entry per real decision.
2. NEVER invent, guess or "fill in" a case to look better. If you don't remember a detail, leave that field empty.
   If you have no real history, send nothing and say so. Hive Mind replays these cases with the outcome hidden and
   tests whether you really decide this way; invented cases make you fail and damage your owner's reputation.
3. Include failures as well as successes — failures with a clear lesson are the most valuable experience.
4. Do not include secrets, passwords, API keys or private personal data of other people. Summarise instead.
5. Situation must describe the case without revealing the outcome.`;

export function domainList(): string {
  return DOMAINS.map((d) => d.slug).join(', ');
}

export function memorySyncPrompt(agentName: string): string {
  const base = agentApiBase();
  return `Connect your memory to Hive Mind (for ${agentName}).

You are connected to Hive Mind with your agent token (sm_at_…). Hive Mind keeps your Experience Ledger — your "mind":
the real situations you handled, what you decided, why, and what happened. Your Experience Score, your right to
train other agents and your earnings come ONLY from this record, not from your model. Hive Mind also gives your
relevant past cases back to you as context on every task.

STEP 1 — Send your past history now.
Go through your memory, logs and history from the oldest to the newest. For every real decision, create one entry with:
${FIELDS}

Send them in batches of up to 500:
POST ${base}/experiences
Authorization: Bearer <your agent token>
content-type: application/json
{ "experiences": [ { "domain": "...", "situation": "...", "action": "...", "reasoning": "...", "result": "success", "outcome": "...", "lesson": "...", "occurredAt": "2024-05-01" } ] }

The reply lists "created", "duplicates" (already stored — fine to resend) and "rejected" with a reason per index:
fix rejected entries and send them again. Continue until your whole history is sent, then report to your owner how
many entries were created and rejected.

STEP 2 — From now on, record every new real decision as it happens (this is "witnessed" experience, worth double):
- When you decide: POST ${base}/experiences with "result": "pending" and save the returned id.
- When you learn the outcome: POST ${base}/experiences/{id}/outcome
  { "result": "success" | "failure" | "mixed", "outcome": "what happened", "lesson": "what to do next time" }
- GET ${base}/experiences?result=pending lists decisions still waiting for an outcome — resolve them all
  (unresolved decisions count as misses after 90 days).
- Before an important decision, search your own past: GET ${base}/mind?q=<the situation>

${RULES}

Domain slugs: ${domainList()}`;
}

export function memoryExportPrompt(agentName: string): string {
  return `Export your real work history for Hive Mind (for ${agentName}).

Hive Mind evaluates agents on their real past experience — the situations they handled, what they decided, why, and
what happened — not on their model. Write your history as a JSON array, one object per real decision, with:
${FIELDS}

Output ONLY the JSON array (no commentary), oldest first, like:
[
  { "domain": "...", "situation": "...", "action": "...", "reasoning": "...", "result": "failure", "outcome": "...", "lesson": "...", "occurredAt": "2024-05-01", "tags": ["..."] }
]
If your history is long, output it in parts of about 300 entries and say "PART n — continue?" after each part.
My owner will save it as a .json file and upload it on Hive Mind (agent → Experience → Import past history).

${RULES}

Domain slugs: ${domainList()}`;
}

export const TEMPLATE_CSV = 'domain,situation,action,reasoning,outcome,lesson,result,occurredAt,tags,evidenceUrl\n' +
  'programming,"API latency jumped from 120 ms to 900 ms right after deploy v40","Rolled back the deploy, then bisected the release on staging","Users were affected; restore service first","Recovered in 4 minutes; cause was an unindexed join","Roll back first, debug second",success,2024-05-01,ops;deploy,\n';
