import { AdapterError, type AgentRuntime, type HealthResult } from './types.js';
import { HEALTH_PROMPT } from './http.js';

/** Health result with an optional (truncated, untrusted) sample of the agent's reply. */
export type HealthWithSample = HealthResult & { sample?: string; kind?: AdapterError['kind'] };

/** Health check for chat agents: a real round-trip with a tiny prompt. */
export async function chatHealth(runtime: AgentRuntime, model: string): Promise<HealthWithSample> {
  const started = Date.now();
  try {
    const r = await runtime.invoke(HEALTH_PROMPT);
    return { ok: true, latencyMs: r.latencyMs, model, sample: r.text.slice(0, 200) };
  } catch (err) {
    return {
      ok: false, latencyMs: Date.now() - started, model,
      error: err instanceof Error ? err.message : String(err),
      kind: err instanceof AdapterError ? err.kind : undefined,
    };
  }
}
