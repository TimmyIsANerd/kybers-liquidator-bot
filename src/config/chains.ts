import { defineChain, http } from 'viem';
import { SupportedChain } from '../types/index.js';

// ─── Wrapped Native Token Addresses ──────────────────────────────────────────

export const WRAPPED_NATIVE: Record<SupportedChain, string> = {
  [SupportedChain.ETH]: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
  [SupportedChain.BSC]: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
};

// USDT references (for USD price lookups)
export const USDT_ADDRESS: Record<SupportedChain, string> = {
  [SupportedChain.ETH]: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  [SupportedChain.BSC]: '0x55d398326f99059fF775485246999027B3197955',
};

// KyberSwap uses this for all native tokens
export const KYBER_NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

export const KYBER_CHAIN_SLUG: Record<SupportedChain, string> = {
  [SupportedChain.ETH]: 'ethereum',
  [SupportedChain.BSC]: 'bsc',
};

// ─── Chain Definitions ────────────────────────────────────────────────────────

function getEthRpc(): string {
  const url = process.env.ETH_RPC_URL;
  if (!url) throw new Error('ETH_RPC_URL is not set');
  return url;
}

function getBscRpc(): string {
  const url = process.env.BSC_RPC_URL;
  if (!url) throw new Error('BSC_RPC_URL is not set');
  return url;
}

export const ethereumChain = defineChain({
  id: 1,
  name: 'Ethereum',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.ETH_RPC_URL || 'https://eth.llamarpc.com'] },
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
    default: { http: [process.env.BSC_RPC_URL || 'https://bsc-dataseed1.binance.org'] },
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

export function getChain(chainId: SupportedChain) {
  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`Unsupported chain: ${chainId}`);
  return chain;
}

export function getTransport(chainId: SupportedChain) {
  const rpcUrl = chainId === SupportedChain.ETH ? process.env.ETH_RPC_URL : process.env.BSC_RPC_URL;
  if (!rpcUrl) throw new Error(`RPC URL not configured for chain ${chainId}`);
  return http(rpcUrl);
}
