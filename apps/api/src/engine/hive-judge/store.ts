/** Hive Judge — settings (system_settings 'hive_judge') and model persistence (system_settings 'hive_judge_model'). */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db/client.js';
import type { HiveModel } from './scorer.js';

export const SETTINGS_KEY = 'hive_judge';
export const MODEL_KEY = 'hive_judge_model';

export const SettingsSchema = z.object({
  /** owner decision: OFF by default — every answer gets a final automatic score */
  reviewEnabled: z.boolean().default(false),
  reviewThreshold: z.number().min(0).max(1).default(0.55),
  reviewDailyCap: z.number().int().min(0).max(10_000).default(50),
  llmEnabled: z.boolean().default(true),
  llmThreshold: z.number().min(0).max(1).default(0.6),
  llmBlendWeight: z.number().min(0).max(1).default(0.5),
  retrainEveryResolutions: z.number().int().min(1).max(10_000).default(20),
}).strict();
export type HiveJudgeSettings = z.infer<typeof SettingsSchema>;

let settingsCache: { at: number; v: HiveJudgeSettings } | null = null;

export async function getSettings(): Promise<HiveJudgeSettings> {
  if (settingsCache && Date.now() - settingsCache.at < 10_000) return settingsCache.v;
  const [row] = await db().select().from(schema.systemSettings).where(eq(schema.systemSettings.key, SETTINGS_KEY)).limit(1);
  const parsed = SettingsSchema.safeParse(row?.value ?? {});
  const v = parsed.success ? parsed.data : SettingsSchema.parse({});
  settingsCache = { at: Date.now(), v };
  return v;
}

export async function putSettings(patch: unknown, actorId: string | null): Promise<HiveJudgeSettings> {
  const cur = await getSettings();
  const v = SettingsSchema.parse({ ...cur, ...(patch as object) });
  await db().insert(schema.systemSettings).values({ key: SETTINGS_KEY, value: v, updatedBy: actorId })
    .onConflictDoUpdate({ target: schema.systemSettings.key, set: { value: v, updatedBy: actorId, updatedAt: new Date() } });
  settingsCache = { at: Date.now(), v };
  return v;
}

let modelCache: HiveModel | null = null;

export function cachedModel() { return modelCache; }
export function setCachedModel(m: HiveModel | null) { modelCache = m; }

export async function loadModel(): Promise<HiveModel | null> {
  if (modelCache) return modelCache;
  const [row] = await db().select().from(schema.systemSettings).where(eq(schema.systemSettings.key, MODEL_KEY)).limit(1);
  const v = row?.value as HiveModel | undefined;
  if (v && v.kind === 'hive-judge-scorer') modelCache = v;
  return modelCache;
}

export async function saveModel(m: HiveModel) {
  await db().insert(schema.systemSettings).values({ key: MODEL_KEY, value: m as unknown as object })
    .onConflictDoUpdate({ target: schema.systemSettings.key, set: { value: m as unknown as object, updatedAt: new Date() } });
  modelCache = m;
}
