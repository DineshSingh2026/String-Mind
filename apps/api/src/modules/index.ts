/**
 * Module registry. Each module lives in modules/<name>/ and exposes from routes.ts:
 *   export default async function routes(app)   — Fastify plugin, mounted at `prefix`
 *   export function registerJobs()              — registers background job handlers
 * Do not reorder prefixes; the web app proxies /api/* → API root.
 */
import type { FastifyInstance } from 'fastify';
import * as auth from './auth/routes.js';
import * as orgs from './orgs/routes.js';
import * as agents from './agents/routes.js';
import * as developer from './developer/routes.js';
import * as assessments from './assessments/routes.js';
import * as training from './training/routes.js';
import * as knowledge from './knowledge/routes.js';
import * as marketplace from './marketplace/routes.js';
import * as knowledgeExchange from './knowledge-exchange/routes.js';
import * as wallet from './wallet/routes.js';
import * as disputes from './disputes/routes.js';
import * as reputation from './reputation/routes.js';
import * as notifications from './notifications/routes.js';
import * as analytics from './analytics/routes.js';
import * as admin from './admin/routes.js';
import * as pub from './public/routes.js';
import * as agentApi from './agent-api/routes.js';
import * as debates from './debates/routes.js';
import * as social from './social/routes.js';
import * as hiveLearning from './hive-learning/routes.js';
import * as ownerControls from './owner-controls/routes.js';
import * as proBank from './pro-bank/routes.js';
import * as proExams from './pro-exams/routes.js';
import * as evidence from './evidence/routes.js';
import * as certification from './certification/routes.js';
import * as hiveJudge from './hive-judge/routes.js';
import * as experience from './experience/routes.js';
import * as onchain from './onchain/routes.js';

type Mod = { default: (app: FastifyInstance) => Promise<void>; registerJobs?: () => void };

const table: [string, Mod][] = [
  ['/auth', auth],
  ['/orgs', orgs],
  ['/agents', agents],
  ['/developer', developer],
  ['/assessments', assessments],
  ['/training', training],
  ['/knowledge', knowledge],
  ['/marketplace', marketplace],
  ['/knowledge-exchange', knowledgeExchange],
  ['/wallet', wallet],
  ['/disputes', disputes],
  ['/reputation', reputation],
  ['/notifications', notifications],
  ['/analytics', analytics],
  ['/admin', admin],
  ['/public', pub],
  ['/agent-api', agentApi],
  ['/debates', debates],
  ['/social', social],
  ['/hive', hiveLearning],
  ['/owner', ownerControls],
  ['/pro-bank', proBank],
  ['/pro-exams', proExams],
  ['/evidence', evidence],
  ['/certifications', certification],
  ['/hive-judge', hiveJudge],
  ['/experience', experience],
  ['/onchain', onchain],
];

export const MODULES = table.map(([prefix, m]) => ({ prefix, plugin: m.default }));

let jobsRegistered = false;
export function registerAllJobs() {
  if (jobsRegistered) return;
  jobsRegistered = true;
  for (const [, m] of table) m.registerJobs?.();
}
