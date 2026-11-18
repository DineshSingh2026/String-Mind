/**
 * Wallet secrets + key management — deterministic derivation from ONE master seed.
 *
 * No private key, seed phrase or secret key is ever written to the database. Every platform-controlled keypair except
 * the Treasury (MID) is derived on demand:
 *
 *     seed = HMAC-SHA256(masterSeed, "hivemind/solana/<scope>/v<version>/<id>")
 *     key  = Ed25519 keypair from that 32-byte seed
 *
 * The database stores only the public address plus (scope, version) — enough to re-derive the same key later, useless
 * without the master seed, which lives in the secret provider (AWS Secrets Manager in production).
 *   - the domain separator keeps agent wallets and any future key family in disjoint key spaces;
 *   - the id is a server-generated UUID (agent id), never user input;
 *   - bumping the version derives a brand-new wallet for the same id (that is how a wallet is rotated).
 *
 * The Treasury's key is NOT derived: it is an existing funded wallet whose base58 secret key is its own secret, and it
 * is checked against MID_WALLET_ADDRESS before every use so a misconfigured secret can never sign as the wrong wallet.
 * The Revenue (ADMIN) key is never loaded by this application.
 */
import { createHmac } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from '../../lib/config.js';

export const AGENT_WALLET_SCOPE = 'agent-wallet';
const MIN_MASTER_SEED_BYTES = 32;

export class SecretUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'SecretUnavailableError'; }
}

/* ───────────── secret provider ───────────── */

const cache = new Map<string, { value: string; at: number }>();
let override: ((id: string) => Promise<string>) | null = null;

/** Tests inject secrets here; production reads AWS Secrets Manager (or DEV_* values outside production). */
export function setSecretProviderForTests(fn: ((id: string) => Promise<string>) | null) { override = fn; cache.clear(); }

export async function getSecret(id: string): Promise<string> {
  if (override) return override(id);
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < config.SECRET_CACHE_TTL_SECONDS * 1000) return hit.value;
  let value: string;
  if (config.SECRET_PROVIDER === 'env') {
    if (config.isProd) throw new SecretUnavailableError('SECRET_PROVIDER=env is refused in production');
    value = id === config.WALLET_MASTER_SEED_SECRET_ID ? config.DEV_WALLET_MASTER_SEED_HEX : id === config.MID_WALLET_KEY_SECRET_ID ? config.DEV_MID_WALLET_PRIVATE_KEY : '';
    if (!value) throw new SecretUnavailableError(`Secret "${id}" is not configured (DEV_* values)`);
  } else {
    try {
      const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
      const res = await new SecretsManagerClient({ region: config.AWS_REGION || undefined }).send(new GetSecretValueCommand({ SecretId: id }));
      value = res.SecretString ?? '';
    } catch (e) {
      // never echo provider details (they can include ARNs / account ids)
      throw new SecretUnavailableError(`Secret "${id}" could not be read from AWS Secrets Manager (${e instanceof Error ? e.name : 'error'})`);
    }
    if (!value) throw new SecretUnavailableError(`Secret "${id}" is empty`);
  }
  cache.set(id, { value, at: Date.now() });
  return value;
}

/* ───────────── derivation ───────────── */

async function masterSeed(): Promise<Buffer> {
  const raw = (await getSecret(config.WALLET_MASTER_SEED_SECRET_ID)).trim();
  if (!/^[0-9a-fA-F]+$/.test(raw) || raw.length % 2 !== 0) throw new SecretUnavailableError('Wallet master seed must be hex-encoded');
  const seed = Buffer.from(raw, 'hex');
  if (seed.length < MIN_MASTER_SEED_BYTES) throw new SecretUnavailableError(`Wallet master seed must be at least ${MIN_MASTER_SEED_BYTES} bytes`);
  return seed;
}

export function deriveFromSeed(seed: Buffer, scope: string, id: string, version: number): Keypair {
  if (!scope || scope.includes('/')) throw new Error('Invalid derivation scope');
  const message = `hivemind/solana/${scope}/v${Math.trunc(version)}/${id}`;
  return Keypair.fromSeed(createHmac('sha256', seed).update(message).digest());
}

export async function deriveKeypair(scope: string, id: string, version = 1): Promise<Keypair> {
  return deriveFromSeed(await masterSeed(), scope, id, version);
}

export const deriveAgentKeypair = (agentId: string, version = 1) => deriveKeypair(AGENT_WALLET_SCOPE, agentId, version);

/** The Treasury (MID) keypair — checked against MID_WALLET_ADDRESS so a wrong secret can never sign as the wrong wallet. */
export async function getMidKeypair(): Promise<Keypair> {
  if (!config.MID_WALLET_ADDRESS) throw new SecretUnavailableError('MID_WALLET_ADDRESS is not configured');
  const secret = (await getSecret(config.MID_WALLET_KEY_SECRET_ID)).trim();
  let kp: Keypair;
  try { kp = Keypair.fromSecretKey(bs58.decode(secret)); } catch { throw new SecretUnavailableError('Treasury (MID) secret is not a valid base58 Solana secret key'); }
  if (kp.publicKey.toBase58() !== config.MID_WALLET_ADDRESS) throw new SecretUnavailableError('Treasury (MID) secret does not match MID_WALLET_ADDRESS — refusing to sign');
  return kp;
}
