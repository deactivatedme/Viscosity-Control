import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
const V4: [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT (also Tailscale)
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, incl. 169.254.169.254 cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
const V6: [string, number][] = [
  ['::', 127], // unspecified + loopback
  ['64:ff9b::', 96], // NAT64 can front any IPv4 address
  ['fc00::', 7], // unique local, incl. fd00:ec2::254 metadata
  ['fe80::', 10],
  ['ff00::', 8],
];
for (const [net, prefix] of V4) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of V6) blocked.addSubnet(net, prefix, 'ipv6');

/** True for loopback, private, link-local, CGNAT, multicast and metadata addresses. */
export function isPrivateAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isPrivateAddress(mapped[1]!);
  const family = isIP(ip);
  if (family === 0) return true; // not an address at all: fail closed
  return blocked.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

export type NetworkGuard = (url: string) => Promise<string | null>;

/**
 * Returns a checker that yields a block reason, or null when the URL may be requested.
 * `allowHosts` (host or host:port) comes from the worker's own config file only.
 * shortcut: the check resolves DNS separately from Chromium, so a rebinding attacker with a
 * sub-second TTL can still race it; upgrade to an egress proxy/netns that pins the checked IP.
 */
export function createNetworkGuard(allowHosts: string[] = []): NetworkGuard {
  const allow = new Set(allowHosts.map((h) => h.toLowerCase()));
  const cache = new Map<string, { at: number; verdict: string | null }>();
  return async (rawUrl) => {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return 'not a valid URL';
    }
    if (['data:', 'blob:', 'about:'].includes(url.protocol)) return null; // no network involved
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return `scheme ${url.protocol} is not allowed`;
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (allow.has(url.host.toLowerCase()) || allow.has(hostname)) return null;
    const hit = cache.get(hostname);
    if (hit && Date.now() - hit.at < 30_000) return hit.verdict;
    let verdict: string | null = null;
    if (isIP(hostname)) {
      if (isPrivateAddress(hostname)) verdict = `${hostname} is a private or internal address`;
    } else {
      // Unresolvable here means Chromium's own request fails too (or an upstream proxy resolves it).
      const addresses = await lookup(hostname, { all: true }).catch(() => []);
      const bad = addresses.find((a) => isPrivateAddress(a.address));
      if (bad) verdict = `${hostname} resolves to private or internal address ${bad.address}`;
    }
    cache.set(hostname, { at: Date.now(), verdict });
    return verdict;
  };
}
