/**
 * tokenService.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Token resolution: DexScreener first, on-chain multicall fallback.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createPublicClient } from 'viem';
import type { Address } from 'viem';
import { getDexScreenerTokenInfo } from '../libs/dexScreener.js';
import { getTokenDataMulticall } from '../libs/erc20.js';
import { getChain, getTransport } from '../config/chains.js';
import type { SupportedChain, TokenInfo } from '../types/index.js';

/**
 * Resolve token information.
 * 1. Try DexScreener (gives name, symbol, decimals, logo, priceUsd)
 * 2. Fallback to on-chain multicall (no price or logo)
 */
export async function resolveToken(
  tokenAddress: string,
  chainId: SupportedChain,
): Promise<TokenInfo | null> {
  // 1. Try DexScreener
  try {
    const dexInfo = await getDexScreenerTokenInfo(tokenAddress, chainId);
    if (dexInfo) return dexInfo;
  } catch (err) {
    console.warn('[TokenService] DexScreener lookup failed:', err);
  }

  // 2. Fallback: on-chain multicall
  try {
    const chain = getChain(chainId);
    const transport = getTransport(chainId);
    const publicClient = createPublicClient({ chain, transport });

    const { name, symbol, decimals } = await getTokenDataMulticall(
      publicClient as any,
      tokenAddress as Address,
      '0x0000000000000000000000000000000000000000',
    );

    return {
      address: tokenAddress,
      name,
      symbol,
      decimals,
      logo: undefined,
      priceUsd: undefined,
    };
  } catch (err) {
    console.error('[TokenService] On-chain fallback failed:', err);
    return null;
  }
}

/**
 * Format a token amount from raw bigint to human-readable string.
 */
export function formatTokenAmount(raw: bigint, decimals: number, maxDecimals = 6): string {
  const divisor = BigInt(10 ** decimals);
  const whole   = raw / divisor;
  const remainder = raw % divisor;

  if (remainder === 0n) return whole.toString();

  const remStr = remainder.toString().padStart(decimals, '0');
  const decimal = remStr.slice(0, maxDecimals).replace(/0+$/, '');
  if (!decimal) return whole.toString();
  return `${whole}.${decimal}`;
}

/**
 * Compute the raw token amount equivalent to a USD value.
 * tokenAmountRaw = (usdAmount / priceUsd) * 10^decimals
 */
export function usdToTokenAmountRaw(
  usdAmount: number,
  priceUsd: number,
  decimals: number,
): bigint {
  if (priceUsd <= 0) throw new Error('Invalid token price');
  const tokenAmount = usdAmount / priceUsd;
  return BigInt(Math.floor(tokenAmount * 10 ** decimals));
}
