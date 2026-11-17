/**
 * WebSocket tokens (GET /auth/ws-token + /ws?token=) used when the web app and the API are on different hosts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app, registerUser, setup, teardown, type Client } from './helpers.js';
import { authenticateWsToken, createWsToken, verifyWsTokenSignature, WS_TOKEN_TTL_MS } from '../src/lib/ws-token.js';

let alice: Client;

beforeAll(async () => {
  await setup();
  alice = await registerUser();
});
afterAll(teardown);

/** Opens /ws with the given query string and resolves with the first server message + close code (if closed). */
async function wsFirstMessage(query: string, headers: Record<string, string> = {}) {
  return new Promise<{ msg: any; closeCode?: number }>((resolve, reject) => {
    let msg: any;
    app.injectWS(`/ws${query}`, { headers } as never, {
      // attach listeners before the upgrade completes — the server greets immediately
      onInit: (ws) => {
        ws.on('message', (raw: Buffer) => {
          const m = JSON.parse(raw.toString());
          if (!msg) msg = m;
          if (m.event === 'ready') { ws.terminate(); resolve({ msg }); }
        });
        ws.on('close', (code: number) => resolve({ msg, closeCode: code }));
      },
    }).catch(reject);
  });
}

describe('ws-token', () => {
  it('requires a signed-in session', async () => {
    const r = await app.inject({ method: 'GET', url: '/auth/ws-token' });
    expect(r.statusCode).toBe(401);
  });

  it('issues a 60s token that authenticates the WebSocket', async () => {
    const r = await alice.request('GET', '/auth/ws-token');
    expect(r.status).toBe(200);
    expect(typeof r.body.token).toBe('string');
    const exp = new Date(r.body.expiresAt).getTime();
    expect(exp - Date.now()).toBeGreaterThan(WS_TOKEN_TTL_MS - 5_000);
    expect(exp - Date.now()).toBeLessThanOrEqual(WS_TOKEN_TTL_MS);

    const auth = await authenticateWsToken(r.body.token);
    expect(auth?.user.email).toBeTruthy();
    expect(auth?.orgId).toBeTruthy();
    expect(auth?.sessionId).toBeTruthy();

    const { msg } = await wsFirstMessage(`?token=${encodeURIComponent(r.body.token)}`);
    expect(msg.event).toBe('ready');
    expect(msg.data.userId).toBe(auth!.user.id);
  });

  it('rejects an expired token', async () => {
    const r = await alice.request('GET', '/auth/ws-token');
    const auth = (await authenticateWsToken(r.body.token))!;
    const old = createWsToken(auth, Date.now() - WS_TOKEN_TTL_MS - 1_000);
    expect(verifyWsTokenSignature(old.token)).toBeNull();
    expect(await authenticateWsToken(old.token)).toBeNull();
    const { msg, closeCode } = await wsFirstMessage(`?token=${encodeURIComponent(old.token)}`);
    expect(msg.data).toBe('unauthorized');
    expect(closeCode).toBe(4401);
  });

  it('rejects a tampered token (payload or signature)', async () => {
    const r = await alice.request('GET', '/auth/ws-token');
    const [body, sig] = (r.body.token as string).split('.');
    const payload = JSON.parse(Buffer.from(body!, 'base64url').toString());
    const forged = Buffer.from(JSON.stringify({ ...payload, exp: payload.exp + 3600_000 })).toString('base64url');
    expect(await authenticateWsToken(`${forged}.${sig}`)).toBeNull();
    const flipped = sig!.slice(0, -2) + (sig!.endsWith('AA') ? 'BB' : 'AA');
    expect(await authenticateWsToken(`${body}.${flipped}`)).toBeNull();
    expect(await authenticateWsToken('garbage')).toBeNull();
    expect(await authenticateWsToken(`${body}.${sig}.extra`)).toBeNull();
    const { closeCode } = await wsFirstMessage(`?token=${encodeURIComponent(`${forged}.${sig}`)}`);
    expect(closeCode).toBe(4401);
  });

  it('stops working once the session is logged out', async () => {
    const bob = await registerUser();
    const r = await bob.request('GET', '/auth/ws-token');
    expect(await authenticateWsToken(r.body.token)).not.toBeNull();
    await bob.request('POST', '/auth/logout');
    expect(await authenticateWsToken(r.body.token)).toBeNull();
  });

  it('still accepts cookie auth (same-origin / local dev)', async () => {
    const { msg } = await wsFirstMessage('', { cookie: alice.cookie });
    expect(msg.event).toBe('ready');
  });
});
