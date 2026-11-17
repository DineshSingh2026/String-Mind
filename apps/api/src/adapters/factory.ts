/** Maps a ConnectionInfo's adapter kind to the runtime implementation. */
import { createA2ARuntime } from './a2a.js';
import { createAnthropicRuntime } from './anthropic.js';
import { createCustomRestRuntime } from './custom-rest.js';
import { createGeminiRuntime } from './gemini.js';
import { createMcpRuntime } from './mcp.js';
import { createOpenAICompatibleRuntime } from './openai-compatible.js';
import { createSandboxRuntime } from './sandbox.js';
import { createWebhookRuntime } from './webhook.js';
import { AdapterError, type AgentRuntime, type ConnectionInfo } from './types.js';

export const ADAPTER_KINDS = ['openai_compatible', 'anthropic', 'gemini', 'sandbox', 'custom_rest', 'webhook', 'a2a', 'mcp'] as const;

const PROVIDER_NAMES: Record<string, string> = {
  openai: 'OpenAI', xai: 'xAI', mistral: 'Mistral', deepseek: 'DeepSeek', 'meta-llama': 'Llama host',
};

export function createRuntime(info: ConnectionInfo): AgentRuntime {
  switch (info.adapter) {
    case 'openai_compatible': return createOpenAICompatibleRuntime(info, PROVIDER_NAMES[info.providerSlug] ?? 'OpenAI-compatible provider');
    case 'anthropic': return createAnthropicRuntime(info);
    case 'gemini': return createGeminiRuntime(info);
    case 'custom_rest': return createCustomRestRuntime(info);
    case 'webhook': return createWebhookRuntime(info);
    case 'a2a': return createA2ARuntime(info);
    case 'mcp': return createMcpRuntime(info);
    case 'sandbox': return createSandboxRuntime(info);
    default: throw new AdapterError(`Unsupported adapter: ${info.adapter}`, 'unsupported');
  }
}
