/**
 * SSRF guard for outbound calls to user-supplied URLs (agent endpoints, developer webhooks).
 *
 *   await assertSafeOutboundUrl(url)   // throws UnsafeUrlError
 *
 * - Only http:// and https:// are allowed (always).
 * - Unless config.ALLOW_PRIVATE_NETWORK_URLS is true (default in development/test so local
 *   Ollama/Llama on localhost works), the hostname is resolved (all A/AAAA records) and the call is
 *   refused if ANY address is loopback, private, link-local (incl. cloud metadata 169.254.169.254),
 *   CGNAT, "this network", unique-local / link-local IPv6 or an IPv4-mapped form of those.
 *
 * Checked at save time (clear 422) and again right before every request (DNS rebinding defence:
 * a hostname that resolved publicly when saved may later resolve to an internal address).
 * Residual risk: fetch() performs its own lookup after this check, so a TTL-0 rebinding race is
 * narrowed, not eliminated; pinning the resolved IP needs a custom undici dispatcher.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { config } from './config.js';
import { unprocessable } from './errors.js';

export class UnsafeUrlError extends Error {}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
}

const V4_BLOCKS: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16],
];

function isPrivateV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return V4_BLOCKS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0);
  });
}

/** True for loopback/private/link-local/metadata/CGNAT/unspecified addresses (IPv4 or IPv6). */
export function isPrivateAddress(ip: string): boolean {
  const addr = ip.replace(/^\[|\]$/g, '').split('%')[0]!.toLowerCase();
  const fam = isIP(addr);
  if (fam === 4) return isPrivateV4(addr);
  if (fam !== 6) return true; // unparseable → refuse
  if (addr === '::' || addr === '::1') return true;
  // IPv4-mapped / -compatible (::ffff:a.b.c.d, ::a.b.c.d, or hex form ::ffff:7f00:1)
  const mapped = addr.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]!);
  const hexMapped = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1]!, 16), lo = parseInt(hexMapped[2]!, 16);
    return isPrivateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const first = parseInt(addr.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

/** Throws UnsafeUrlError if `raw` is not an http(s) URL to a public address (see module doc). */
export async function assertSafeOutboundUrl(raw: string): Promise<void> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new UnsafeUrlError('URL is not valid'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UnsafeUrlError('Only http:// and https:// URLs are allowed');
  if (config.ALLOW_PRIVATE_NETWORK_URLS) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addrs: string[];
  if (isIP(host)) addrs = [host];
  else {
    try {
      addrs = (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    } catch {
      throw new UnsafeUrlError(`Could not resolve host "${host}"`);
    }
  }
  if (!addrs.length || addrs.some(isPrivateAddress)) {
    throw new UnsafeUrlError(`URL host "${host}" resolves to a private, loopback or link-local address; outbound calls to internal networks are not allowed`);
  }
}

/** Save-time variant: maps UnsafeUrlError to a 422 API error. */
export async function assertSafeUrlForSave(raw: string, field = 'URL'): Promise<void> {
  try { await assertSafeOutboundUrl(raw); } catch (err) {
    if (err instanceof UnsafeUrlError) throw unprocessable(`${field} rejected: ${err.message}`);
    throw err;
  }
}
