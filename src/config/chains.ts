/**
 * chains.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Chain definitions for ETH and BSC with hardcoded public RPC endpoints.
 * Uses viem's fallback() transport — tries each RPC in order; if one fails
 * (timeout, rate-limit, error) the next one is used automatically.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { defineChain, fallback, http } from 'viem';
import { SupportedChain } from '../types/index.js';

// ─── RPC Endpoints ────────────────────────────────────────────────────────────

/**
 * Ethereum public RPC endpoints.
 * Ordered by reliability preference — custom ETH_RPC_URL is tried first if set.
 */
const ETH_RPCS_BUILTIN = [
  'https://eth1.lava.build',
  'https://ethereum-rpc.publicnode.com',
  'https://eth.rpc.blxrbdn.com',
  'https://rpc.flashbots.net/fast',
  'https://rpc.flashbots.net',
  'https://1rpc.io/eth',
  'https://public-eth.nownodes.io',
  'https://api.zan.top/eth-mainnet',
  'https://rpc.mevblocker.io',
] as const;

/**
 * BNB Chain public RPC endpoints.
 * Ordered by reliability preference — custom BSC_RPC_URL is tried first if set.
 */
const BSC_RPCS_BUILTIN = [
  'https://binance.llamarpc.com',
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-dataseed1.bnbchain.org',
  'https://bsc-dataseed2.bnbchain.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed2.defibit.io',
  'https://bsc-dataseed3.defibit.io',
  'https://bsc-dataseed4.defibit.io',
  'https://bsc-dataseed2.ninicoin.io',
  'https://bsc-dataseed3.ninicoin.io',
  'https://bsc-dataseed4.ninicoin.io',
] as const;

// ─── Transport Builder ────────────────────────────────────────────────────────

/**
 * Build a viem fallback transport from a list of RPC URLs.
 * Each HTTP transport has a 10s timeout. If one fails, viem automatically
 * tries the next in the list.
 *
 * Optional env-var overrides are prepended so they're tried first:
 *   ETH_RPC_URL=... (for Ethereum)
 *   BSC_RPC_URL=... (for BSC)
 */
function buildFallbackTransport(
  builtinUrls: readonly string[],
  envOverride?: string,
) {
  const urls: string[] = [];

  // Prepend custom RPC if provided (takes priority)
  if (envOverride?.trim()) urls.push(envOverride.trim());

  // Append all built-in endpoints
  urls.push(...builtinUrls);

  return fallback(
    urls.map(url =>
      http(url, {
        timeout: 10_000,         // 10s per request before trying next
        fetchOptions: {
          headers: { 'Content-Type': 'application/json' },
        },
      }),
    ),
    {
      rank: false,               // Round-robin priority, not latency ranking
      retryCount: 2,             // Retry on same endpoint before moving on
      retryDelay: 100,
    },
  );
}

// ─── Wrapped Native Token Addresses ──────────────────────────────────────────

export const WRAPPED_NATIVE: Record<SupportedChain, string> = {
  [SupportedChain.ETH]: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
  [SupportedChain.BSC]: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
};

export const USDT_ADDRESS: Record<SupportedChain, string> = {
  [SupportedChain.ETH]: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  [SupportedChain.BSC]: '0x55d398326f99059fF775485246999027B3197955',
};

/** KyberSwap uses this address to represent native tokens on all chains */
export const KYBER_NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

export const KYBER_CHAIN_SLUG: Record<SupportedChain, string> = {
  [SupportedChain.ETH]: 'ethereum',
  [SupportedChain.BSC]: 'bsc',
};

// ─── Chain Definitions ────────────────────────────────────────────────────────

export const ethereumChain = defineChain({
  id: 1,
  name: 'Ethereum',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    // Primary RPC used by viem when it needs a single URL (e.g. for display).
    // Actual requests go through the fallback transport below.
    default: { http: [process.env.ETH_RPC_URL?.trim() || ETH_RPCS_BUILTIN[0]] },
  },
  blockExplorers: {
    default: { name: 'Etherscan', url: 'https://etherscan.io' },
  },
  contracts: {
    multicall3: {
      address: '0xca11bde05977b3631167028862be2a173976ca11',
      blockCreated: 14353601,
    },
  },
});

export const bscChain = defineChain({
  id: 56,
  name: 'BNB Smart Chain',
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.BSC_RPC_URL?.trim() || BSC_RPCS_BUILTIN[0]] },
  },
  blockExplorers: {
    default: { name: 'BscScan', url: 'https://bscscan.com' },
  },
  contracts: {
    multicall3: {
      address: '0xca11bde05977b3631167028862be2a173976ca11',
      blockCreated: 15921452,
    },
  },
});

export const CHAINS = {
  [SupportedChain.ETH]: ethereumChain,
  [SupportedChain.BSC]: bscChain,
} as const;

// ─── Public Accessors ─────────────────────────────────────────────────────────

export function getChain(chainId: SupportedChain) {
  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`Unsupported chain: ${chainId}`);
  return chain;
}

/**
 * Returns a viem fallback transport for the given chain.
 * Custom env-var RPC (ETH_RPC_URL / BSC_RPC_URL) is prepended if set,
 * then all built-in public endpoints are used as fallbacks.
 */
export function getTransport(chainId: SupportedChain) {
  if (chainId === SupportedChain.ETH) {
    return buildFallbackTransport(ETH_RPCS_BUILTIN, process.env.ETH_RPC_URL);
  }
  if (chainId === SupportedChain.BSC) {
    return buildFallbackTransport(BSC_RPCS_BUILTIN, process.env.BSC_RPC_URL);
  }
  throw new Error(`No transport configured for chain: ${chainId}`);
}

/** List of all RPC URLs for a chain (for logging / health checks) */
export function getRpcList(chainId: SupportedChain): string[] {
  const builtin = chainId === SupportedChain.ETH
    ? [...ETH_RPCS_BUILTIN]
    : [...BSC_RPCS_BUILTIN];

  const override = chainId === SupportedChain.ETH
    ? process.env.ETH_RPC_URL?.trim()
    : process.env.BSC_RPC_URL?.trim();

  return override ? [override, ...builtin] : builtin;
}
