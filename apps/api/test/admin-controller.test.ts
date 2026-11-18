import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loginAdmin, registerUser, setup, teardown } from './helpers.js';

beforeAll(async () => { await setup(); });
afterAll(async () => { await teardown(); });

describe('admin is a controller, not a participant', () => {
  it('gets no welcome bonus and no token balance, and /auth/me reports none', async () => {
    const admin = await loginAdmin();
    const me = await admin.request('GET', '/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.platformRole).toBe('super_admin');
    expect(me.body.welcomeBonus).toBeNull();
    const ov = await admin.request('GET', '/admin/overview');
    expect(ov.body.tokens.welcomeBonusesGranted).toBe(0);
    expect(ov.body.tokens.inCirculation).toBe(0);
  });

  it('cannot create agents, request training or publish listings', async () => {
    const admin = await loginAdmin();
    for (const [url, body] of [['/agents', { name: 'Nope', providerSlug: 'sandbox' }], ['/training/requests', {}], ['/marketplace/listings', {}]] as const) {
      const r = await admin.request('POST', url, body);
      expect(r.status, url).toBe(403);
    }
  });

  it('a normal member still gets the welcome bonus and counts in circulation', async () => {
    const u = await registerUser();
    expect((await u.request('GET', '/auth/me')).body.welcomeBonus?.granted).toBe(true);
    const admin = await loginAdmin();
    expect((await admin.request('GET', '/admin/overview')).body.tokens.inCirculation).toBeGreaterThan(0);
  });
});

describe('GET /admin/command-center', () => {
  it('is admin-only', async () => {
    const u = await registerUser();
    expect((await u.request('GET', '/admin/command-center')).status).toBe(403);
  });

  it('returns live, zero-filled aggregates excluding the platform org', async () => {
    const admin = await loginAdmin();
    const r = await admin.request('GET', '/admin/command-center');
    expect(r.status).toBe(200);
    const d = r.body;
    expect(d.members.total).toBeGreaterThanOrEqual(1);
    expect(d.members.admins).toBe(1);
    expect(d.series.signups).toHaveLength(14);
    expect(d.series.signups.reduce((s: number, p: { value: number }) => s + p.value, 0)).toBe(d.members.total);
    expect(d.economy.welcomeBonuses).toBe(d.members.total);
    expect(Array.isArray(d.recent)).toBe(true);
    expect(d.attention).toHaveProperty('disputes');
  });
});
