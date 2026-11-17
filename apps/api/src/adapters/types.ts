/**
 * Standard internal Hive Mind agent interface. Every provider is wrapped by an adapter
 * implementing `AgentRuntime`. Providers differ — adapters declare what they support
 * in `capabilities` and must never pretend to support something they don't.
 */

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export interface InvokeRequest {
  messages: ChatMessage[];
  /** extra system context injected by Hive Mind (instructions, retrieved knowledge, memories) */
  system?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** caller purpose — used for usage accounting/logs */
  purpose?: 'assessment' | 'training' | 'health' | 'playground';
}

export interface InvokeResult {
  text: string;
  latencyMs: number;
  usage?: { inputTokens?: number; outputTokens?: number };
  raw?: unknown;
}

export interface AdapterCapabilities {
  chat: boolean;
  tools: boolean;
  streaming: boolean;
  fineTuning: boolean;
  /** true if Hive Mind can push persistent context (instructions/memory/RAG) into each call */
  contextInjection: boolean;
}

export interface HealthResult { ok: boolean; latencyMs: number; error?: string; model?: string }

export interface AgentRuntime {
  readonly adapter: string;
  readonly capabilities: AdapterCapabilities;
  invoke(req: InvokeRequest): Promise<InvokeResult>;
  health(): Promise<HealthResult>;
}

/** Decrypted connection info handed to adapter factories (never leaves the server). */
export interface ConnectionInfo {
  agentId: string;
  orgId: string;
  providerSlug: string;
  adapter: string;
  model: string;
  baseUrl: string | null;
  apiKey: string | null;
  config: Record<string, unknown>;
  webhookSecret: string | null;
}

export class AdapterError extends Error {
  constructor(message: string, public kind: 'auth' | 'rate_limit' | 'timeout' | 'network' | 'bad_response' | 'unsupported' | 'config') {
    super(message);
  }
}
