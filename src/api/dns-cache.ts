/**
 * DNS lookup cache for the Daikin HTTP clients.
 *
 * Every request resolves its hostname again, and a slow or partly-dead resolver
 * charges that to each one. Seen in the field: a container whose first
 * nameserver did not answer had ~5s per lookup, which was long enough to burn
 * the request timeout before a single byte went out - the plugin could not talk
 * to Daikin at all while curl on the same host was fine.
 *
 * Caching removes the per-request cost. The TTL stays short because these are
 * CDN hostnames and their addresses do rotate.
 */
import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress, LookupOptions } from 'node:dns';

const CACHE_TTL_MS = 5 * 60 * 1000;

type CachedEntry = {
    addresses: LookupAddress[];
    expiresAt: number;
};

const cache = new Map<string, CachedEntry>();

/** Drop everything - used by tests, and after a connection error worth re-resolving. */
export function clearDnsCache(): void {
  cache.clear();
}

/**
 * Lookup function shaped for `https.request({ lookup })`.
 *
 * Caches the full address list per hostname and answers from it, honouring the
 * `all` flag the caller asked for.
 */
export const cachedLookup = (
  hostname: string,
  options: LookupOptions,
  callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void => {
  const cached = cache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) {
    respond(cached.addresses, options, callback);
    return;
  }

  dnsLookup(hostname, { all: true, family: options.family }, (error, addresses) => {
    if (error) {
      callback(error, []);
      return;
    }
    cache.set(hostname, { addresses, expiresAt: Date.now() + CACHE_TTL_MS });
    respond(addresses, options, callback);
  });
};

function respond(
  addresses: LookupAddress[],
  options: LookupOptions,
  callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void {
  if (!addresses.length) {
    const error: NodeJS.ErrnoException = new Error('No addresses for hostname');
    error.code = 'ENOTFOUND';
    callback(error, []);
    return;
  }

  if (options.all) {
    callback(null, addresses);
    return;
  }

  callback(null, addresses[0].address, addresses[0].family);
}
