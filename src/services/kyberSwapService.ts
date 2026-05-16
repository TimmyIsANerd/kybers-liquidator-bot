/**
 * kyberSwapService.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * KyberSwap Aggregator API integration.
 * Ported and adapted from boohaa-modular-bot/src/services/kyberSwapService.ts
 * ─────────────────────────────────────────────────────────────────────────────
 */

import axios from 'axios';
import axiosRetry from 'axios-retry';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { Address } from 'viem';
import { SupportedChain } from '../types/index.js';
import { KYBER_CHAIN_SLUG, KYBER_NATIVE, WRAPPED_NATIVE } from '../config/chains.js';

const AGGREGATOR_API_URL = 'https://aggregator-api.kyberswap.com';

// ─── Platform Fee Config ──────────────────────────────────────────────────────

/**
 * Trading fee collected on every successful liquidation swap.
 * KyberSwap uses "per cent mille" (pcm) units: 1 pcm = 0.001%, so 5% = 5000 pcm.
 * The fee is deducted from the swap output and sent to FEE_RECEIVER on-chain.
 */
export const FEE_RECEIVER = '0x29A54694cDf4bC3e8b2665ae29b852475db0982d' as const;
export const FEE_PCM      = 5000; // 5% (5000 / 100_000 = 0.05 = 5%)

// ─── Proxy & Axios Setup ──────────────────────────────────────────────────────

const proxyUrl = process.env.KYBERSWAP_PROXY_URL || process.env.RESIDENTIAL_PROXY_URL || null;
const httpsAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

const kyberAxios = axios.create({ ...(httpsAgent ? { httpsAgent } : {}) });
// @ts-ignore
axiosRetry(kyberAxios, {
  retries: 3,
  retryDelay: (n: number) => n * 1000,
  retryCondition: (e: any) =>
    axiosRetry.isNetworkOrIdempotentRequestError(e) ||
    (e.response && (e.response.status === 429 || e.response.status >= 500)),
});

// ─── Headers ─────────────────────────────────────────────────────────────────

function getHeaders() {
  return {
    headers: {
      'X-Client-Id': process.env.KYBERSWAP_CLIENT_ID || 'kyber-liquidator-bot',
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0',
    },
  };
}

// ─── Chain Slug ───────────────────────────────────────────────────────────────

function getSlug(chainId: SupportedChain): string {
  const slug = KYBER_CHAIN_SLUG[chainId];
  if (!slug) throw new Error(`Unsupported chain for KyberSwap: ${chainId}`);
  return slug;
}

/**
 * Maps WETH/WBNB wrapped addresses to KyberSwap's native token address.
 * KyberSwap uses 0xEeee...EEeE to represent native tokens on all chains.
 */
function normalizeForKyber(address: string, chainId: SupportedChain): string {
  const wrappedNative = WRAPPED_NATIVE[chainId]?.toLowerCase();
  if (address.toLowerCase() === wrappedNative) return KYBER_NATIVE;
  return address;
}

// ─── API Calls ────────────────────────────────────────────────────────────────

/**
 * Get optimal swap route from KyberSwap Aggregator.
 * Includes the 1% platform fee params so KyberSwap handles the fee on-chain.
 */
export async function getSwapRoute(
  chainId: SupportedChain,
  tokenIn: string,
  tokenOut: string,
  amountIn: string,
): Promise<any> {
  const slug = getSlug(chainId);
  const res = await kyberAxios.get(`${AGGREGATOR_API_URL}/${slug}/api/v1/routes`, {
    params: {
      tokenIn:     normalizeForKyber(tokenIn, chainId),
      tokenOut:    normalizeForKyber(tokenOut, chainId),
      amountIn,
      saveGas:     0,
      gasInclude:  1,
      // Platform fee: 1% collected on-chain, sent to FEE_RECEIVER
      feeAddress:  FEE_RECEIVER,
      feePcm:      FEE_PCM,
    },
    ...getHeaders(),
  });
  return res.data.data;
}

/**
 * Build swap transaction from a route summary.
 */
export async function buildSwapTransaction(
  chainId: SupportedChain,
  routeSummary: any,
  params: any = {},
): Promise<any> {
  const slug = getSlug(chainId);
  const res = await kyberAxios.post(
    `${AGGREGATOR_API_URL}/${slug}/api/v1/route/build`,
    { routeSummary, ...params },
    getHeaders(),
  );
  return res.data.data;
}

/**
 * Get swap calldata (quote + build in one call).
 * A 1% platform fee is automatically included in the route via feeAddress + feePcm.
 * Returns the raw transaction to sign + broadcast, and the expected output amount.
 */
export async function getSwapCallData(params: {
  chainId: SupportedChain;
  tokenIn: string;     // token to sell
  tokenOut: string;    // native token address or KYBER_NATIVE
  amountIn: string;    // raw amount in token decimals (bigint string)
  from: string;        // sender wallet address
  slippage: number;    // decimal, e.g. 0.01 = 1%
}): Promise<{
  tx: {
    to: Address;
    data: `0x${string}`;
    value: bigint;
    gas?: bigint;
    gasPrice?: bigint;
  };
  dstAmount: string;
}> {
  const { chainId, tokenIn, tokenOut, amountIn, from, slippage } = params;
  const slippageBps = Math.floor(slippage * 10_000);

  const routeData = await getSwapRoute(chainId, tokenIn, tokenOut, amountIn);

  if (!routeData?.routeSummary) {
    throw new Error('KyberSwap: No route found for this token pair');
  }

  const buildData = await buildSwapTransaction(chainId, routeData.routeSummary, {
    sender: from,
    recipient: from,
    slippageTolerance: slippageBps,
  });

  return {
    tx: {
      to: buildData.routerAddress as Address,
      data: buildData.data as `0x${string}`,
      value: BigInt(buildData.transactionValue || buildData.value || '0'),
      gas: buildData.gas ? BigInt(buildData.gas) : undefined,
      gasPrice: buildData.gasPrice ? BigInt(buildData.gasPrice) : undefined,
    },
    dstAmount: buildData.amountOut || '0',
  };
}

/**
 * Quick quote — get expected output for a given input amount.
 */
export async function getQuote(
  chainId: SupportedChain,
  tokenIn: string,
  tokenOut: string,
  amountIn: string,
): Promise<{ dstAmount: string }> {
  const routeData = await getSwapRoute(chainId, tokenIn, tokenOut, amountIn);
  if (!routeData?.routeSummary?.amountOut) {
    throw new Error('KyberSwap: No route or missing output amount');
  }
  return { dstAmount: routeData.routeSummary.amountOut };
}
