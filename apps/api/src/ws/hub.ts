/**
 * Realtime pub/sub over WebSocket.
 * Client connects to ws://<api>/ws?token=<GET /auth/ws-token> (or same-origin session cookie), then sends
 *   { "type": "subscribe", "channel": "session:<trainingSessionId>" }
 * Channels: `user:<userId>` (auto-subscribed), `session:<trainingSessionId>`, `assessment:<assessmentId>`.
 * Server pushes { "channel", "event", "data" }.
 *
 * Channel authorisation is delegated to guards registered by modules (registerChannelGuard).
 */
import type { WebSocket } from 'ws';
import type { AuthContext } from '../lib/auth.js';

type Guard = (auth: AuthContext, id: string) => Promise<boolean>;
const guards = new Map<string, Guard>();
const subs = new Map<string, Set<WebSocket>>();

export function registerChannelGuard(prefix: string, guard: Guard) { guards.set(prefix, guard); }

export async function subscribe(ws: WebSocket, auth: AuthContext, channel: string): Promise<boolean> {
  const [prefix, id] = channel.split(':');
  if (!prefix || !id) return false;
  if (prefix === 'user') { if (id !== auth.user.id) return false; }
  else {
    const g = guards.get(prefix);
    if (!g || !(await g(auth, id))) return false;
  }
  if (!subs.has(channel)) subs.set(channel, new Set());
  subs.get(channel)!.add(ws);
  ws.once('close', () => { subs.get(channel)?.delete(ws); });
  return true;
}

export function publish(channel: string, event: string, data: unknown) {
  const set = subs.get(channel);
  if (!set?.size) return;
  const msg = JSON.stringify({ channel, event, data });
  for (const ws of set) if (ws.readyState === 1) ws.send(msg);
}
