/**
 * IDLEMINE price feed — Helius DAS over the Solana RPC (getAssetBatch → token_info.price_info, quoted in USDC). SOL and
 * IDLEMINE come back in one call, no separate price-API key. Prices are "now" only. A missing or non-positive price
 * THROWS rather than guessing. On a test network fixed TEST_*_USD_PRICE values are used (refused on mainnet).
 *
 * Conservative deposit pricing: pricing a deposit at verify time alone hands the depositor a free option (wait for an
 * IDLEMINE dip — or push one on a thin DEX — then verify). So the worker samples prices every minute and a deposit is
 * valued with the price LEAST favourable to the depositor among: now, the sample nearest its block time, and a floor no
 * more than `maxDrop` below the trailing 1 h median. Stablecoins are exactly 1 USD; 1 IDLEMINE == 1 IDLE (never via USD).
 *
 * All arithmetic is fixed-point bigint (scale 1e18): no float ever touches a credited amount.
 */
import { and, asc, between, gte, lt, eq, sql } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { config } from '../../lib/config.js';
import { rpc, WRAPPED_SOL_MINT, type Asset } from './solana.js';

export const SCALE = 10n ** 18n;
const SAMPLE_RETENTION_MS = 7 * 86_400_000;
const BLOCK_TIME_MAX_GAP_MS = 5 * 60_000;
const MEDIAN_WINDOW_MS = 3_600_000;

/** Exact decimal string (or JSON number, incl. exponent form) → fixed-point bigint. Extra precision is truncated. */
export function toFixed(v: string | number): bigint {
  let s = String(v).trim().toLowerCase();
  const m = /^(-?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/.exec(s);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) throw new Error(`Not a number: ${s}`);
  let digits = (m[2] ?? '') + (m[3] ?? '');
  let exp = Number(m[4] ?? 0) - (m[3] ?? '').length + 18;
  s = digits.replace(/^0+/, '') || '0';
  let n = BigInt(s);
  n = exp >= 0 ? n * 10n ** BigInt(exp) : n / 10n ** BigInt(-exp);
  return m[1] === '-' ? -n : n;
}
export const mulFixed = (a: bigint, b: bigint) => (a * b) / SCALE;
export const divFixed = (a: bigint, b: bigint) => (a * SCALE) / b;
export const fixedToString = (n: bigint, dp = 12): string => {
  const neg = n < 0n; const x = neg ? -n : n;
  const whole = x / SCALE; const frac = (x % SCALE).toString().padStart(18, '0').slice(0, dp).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
};

export interface PriceQuote { assetUsdPrice: bigint | null; idlemineUsdPrice: bigint | null; source: string; quotedAt: Date }

const priceSource = () => (config.isTestNetwork ? 'test-fixed' : 'helius-das');

async function usdPrices(...mints: string[]): Promise<Record<string, bigint>> {
  if (config.isTestNetwork) {
    const fixed: Record<string, string> = { [config.IDLEMINE_MINT]: config.TEST_IDLEMINE_USD_PRICE, [WRAPPED_SOL_MINT]: config.TEST_SOL_USD_PRICE };
    const out: Record<string, bigint> = {};
    for (const m of mints) {
      const p = fixed[m] ? toFixed(fixed[m]!) : 0n;
      if (p <= 0n) throw new Error(`No TEST_*_USD_PRICE configured for ${m} on ${config.SOLANA_NETWORK}`);
      out[m] = p;
    }
    return out;
  }
  const assets = await rpc<({ id: string; token_info?: { price_info?: { price_per_token?: number | string } } } | null)[] | null>('getAssetBatch', { ids: mints, displayOptions: { showFungible: true } });
  const out: Record<string, bigint> = {};
  for (const a of assets ?? []) {
    const p = a?.token_info?.price_info?.price_per_token;
    if (a && p != null) out[a.id] = toFixed(p);
  }
  for (const m of mints) if ((out[m] ?? 0n) <= 0n) throw new Error(`No price available from RPC for ${m}`);
  return out;
}

/** IDLEMINE's own current USD price (fixed-point). */
export async function currentIdlemineUsdPrice(): Promise<bigint> {
  return (await usdPrices(config.IDLEMINE_MINT))[config.IDLEMINE_MINT]!;
}

export async function quoteForDeposit(asset: Asset): Promise<PriceQuote> {
  const now = new Date();
  if (asset === 'IDLEMINE') {
    // 1 IDLEMINE == 1 IDLE: its USD price is recorded when available but its absence never blocks the credit
    const p = await usdPrices(config.IDLEMINE_MINT).then((r) => r[config.IDLEMINE_MINT]!, () => null);
    return { assetUsdPrice: p, idlemineUsdPrice: p, source: priceSource(), quotedAt: now };
  }
  if (asset === 'USDC' || asset === 'USDT') {
    const idle = (await usdPrices(config.IDLEMINE_MINT))[config.IDLEMINE_MINT]!;
    return { assetUsdPrice: SCALE, idlemineUsdPrice: idle, source: `${priceSource()}+stable-1usd`, quotedAt: now };
  }
  const p = await usdPrices(WRAPPED_SOL_MINT, config.IDLEMINE_MINT);
  return { assetUsdPrice: p[WRAPPED_SOL_MINT]!, idlemineUsdPrice: p[config.IDLEMINE_MINT]!, source: priceSource(), quotedAt: now };
}

export async function recordPriceSamples(): Promise<void> {
  const prices = await usdPrices(WRAPPED_SOL_MINT, config.IDLEMINE_MINT);
  for (const [mint, price] of Object.entries(prices)) await db().insert(schema.tokenPriceSamples).values({ mint, usdPrice: fixedToString(price, 18), source: priceSource() });
  await db().delete(schema.tokenPriceSamples).where(lt(schema.tokenPriceSamples.sampledAt, new Date(Date.now() - SAMPLE_RETENTION_MS)));
}

async function sampleNear(mint: string, at: Date): Promise<bigint | null> {
  const rows = await db().select().from(schema.tokenPriceSamples).where(and(eq(schema.tokenPriceSamples.mint, mint),
    between(schema.tokenPriceSamples.sampledAt, new Date(at.getTime() - BLOCK_TIME_MAX_GAP_MS), new Date(at.getTime() + BLOCK_TIME_MAX_GAP_MS))));
  if (!rows.length) return null;
  rows.sort((a, b) => Math.abs(a.sampledAt.getTime() - at.getTime()) - Math.abs(b.sampledAt.getTime() - at.getTime()));
  return toFixed(rows[0]!.usdPrice);
}

async function medianSince(mint: string, since: Date): Promise<bigint | null> {
  const rows = await db().select({ p: schema.tokenPriceSamples.usdPrice }).from(schema.tokenPriceSamples)
    .where(and(eq(schema.tokenPriceSamples.mint, mint), gte(schema.tokenPriceSamples.sampledAt, since))).orderBy(asc(sql`${schema.tokenPriceSamples.usdPrice}::numeric`));
  if (!rows.length) return null;
  const v = rows.map((r) => toFixed(r.p));
  return v.length % 2 ? v[(v.length - 1) / 2]! : (v[v.length / 2 - 1]! + v[v.length / 2]!) / 2n;
}

export async function conservativeDepositQuote(asset: Asset, blockTime: Date | null, maxDropPct: number): Promise<PriceQuote> {
  const now = await quoteForDeposit(asset);
  if (asset === 'IDLEMINE') return now; // credited 1:1 — no price exposure
  const sources = ['now'];
  const idle: bigint[] = [now.idlemineUsdPrice!];
  const assetP: bigint[] = [now.assetUsdPrice!];
  if (blockTime) {
    const atBlock = await sampleNear(config.IDLEMINE_MINT, blockTime);
    if (atBlock) { idle.push(atBlock); sources.push('block-time'); }
    if (asset === 'SOL') { const sol = await sampleNear(WRAPPED_SOL_MINT, blockTime); if (sol) assetP.push(sol); }
  }
  const median = await medianSince(config.IDLEMINE_MINT, new Date(Date.now() - MEDIAN_WINDOW_MS));
  if (median && maxDropPct > 0) {
    const floor = mulFixed(median, SCALE - toFixed(maxDropPct));
    if (floor > idle.reduce((a, b) => (b > a ? b : a))) sources.push('median-floor');
    idle.push(floor);
  }
  // higher IDLEMINE price and lower asset price ⇒ fewer IDLE credited
  return {
    assetUsdPrice: assetP.reduce((a, b) => (b < a ? b : a)), idlemineUsdPrice: idle.reduce((a, b) => (b > a ? b : a)),
    source: sources.join('+').slice(0, 32), quotedAt: new Date(),
  };
}
