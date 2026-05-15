import type { TokenInfo } from '../types/index.js';
import type { SupportedChain } from '../types/index.js';
import { proxyFetch } from './proxy-fetch.js';

// ─── Cache ────────────────────────────────────────────────────────────────────

const cache = new Map<string, { t: number; v: TokenInfo | null; isError?: boolean }>();
const CACHE_TTL = 30_000;          // 30s for found tokens
const CACHE_TTL_NOT_FOUND = 60_000; // 1m for confirmed not-found
const CACHE_TTL_ERROR = 10_000;    // 10s for errors (allow quick retry)

const CHAIN_SLUG: Record<number, string> = {
  1: 'ethereum',
  56: 'bsc',
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get token info from DexScreener.
 * Returns { name, symbol, decimals, logo, priceUsd, ... } or null if not found.
 */
export async function getDexScreenerTokenInfo(
  tokenAddress: string,
  chainId: SupportedChain,
): Promise<TokenInfo | null> {
  const chainSlug = CHAIN_SLUG[chainId];
  if (!chainSlug) return null;

  const cacheKey = `${chainId}:${tokenAddress.toLowerCase()}`;
  const now = Date.now();
  const hit = cache.get(cacheKey);

  if (hit) {
    const ttl = hit.v === null ? (hit.isError ? CACHE_TTL_ERROR : CACHE_TTL_NOT_FOUND) : CACHE_TTL;
    if (now - hit.t < ttl) return hit.v;
  }

  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
    console.log(`[DEXSCREENER] Fetching: ${url}`);

    const response = await proxyFetch(url, {
      signal: AbortSignal.timeout(20_000),
      headers: { accept: 'application/json' },
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json() as { pairs?: any[] };
    const pairs = data.pairs ?? [];

    // Filter to the correct chain
    const chainPairs = pairs.filter((p: any) => p.chainId === chainSlug);

    // Find a pair where this address is the base token (preferred)
    const pair =
      chainPairs.find((p: any) => p.baseToken?.address?.toLowerCase() === tokenAddress.toLowerCase()) ||
      chainPairs.find((p: any) => p.quoteToken?.address?.toLowerCase() === tokenAddress.toLowerCase()) ||
      chainPairs[0];

    if (!pair) {
      cache.set(cacheKey, { t: now, v: null, isError: false });
      return null;
    }

    const isBase = pair.baseToken?.address?.toLowerCase() === tokenAddress.toLowerCase();
    const tokenData = isBase ? pair.baseToken : pair.quoteToken;

    const info: TokenInfo = {
      address: tokenData?.address || tokenAddress,
      name: tokenData?.name || 'Unknown',
      symbol: tokenData?.symbol || 'UNKNOWN',
      decimals: tokenData?.decimals ?? 18,
      logo: pair.info?.imageUrl,
      priceUsd: pair.priceUsd,
      priceNative: pair.priceNative,
      volume24h: pair.volume?.h24,
      marketCap: pair.marketCap,
      liquidity: pair.liquidity?.usd,
    };

    console.log(`[DEXSCREENER] ✅ ${info.name} (${info.symbol}) — $${info.priceUsd ?? 'N/A'}`);
    cache.set(cacheKey, { t: now, v: info });
    return info;
  } catch (err) {
    console.error('[DEXSCREENER] Error:', err);
    cache.set(cacheKey, { t: now, v: null, isError: true });
    return null;
  }
}

export function clearDexScreenerCache(): void {
  cache.clear();
}
