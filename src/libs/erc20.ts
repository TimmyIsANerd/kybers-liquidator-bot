import { type Address, type PublicClient } from 'viem';

// ─── ERC20 ABI (minimal) ─────────────────────────────────────────────────────

export const ERC20_ABI = [
  {
    type: 'function', name: 'decimals',
    stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function', name: 'symbol',
    stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }],
  },
  {
    type: 'function', name: 'name',
    stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }],
  },
  {
    type: 'function', name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function', name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function', name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

// ─── Multicall Helpers ────────────────────────────────────────────────────────

export interface TokenOnChainData {
  symbol: string;
  name: string;
  decimals: number;
  balance: bigint;
}

/**
 * Read token metadata + wallet balance in a single multicall.
 * Adapted from the liquidator/index.ts multicall pattern.
 */
export async function getTokenDataMulticall(
  publicClient: PublicClient,
  tokenAddress: Address,
  walletAddress: Address,
): Promise<TokenOnChainData> {
  const results = await publicClient.multicall({
    contracts: [
      { address: tokenAddress, abi: ERC20_ABI, functionName: 'symbol' },
      { address: tokenAddress, abi: ERC20_ABI, functionName: 'name' },
      { address: tokenAddress, abi: ERC20_ABI, functionName: 'decimals' },
      { address: tokenAddress, abi: ERC20_ABI, functionName: 'balanceOf', args: [walletAddress] },
    ],
    allowFailure: true,
  });

  const symbol   = results[0]?.status === 'success' ? (results[0].result as string)  : 'UNKNOWN';
  const name     = results[1]?.status === 'success' ? (results[1].result as string)  : 'Unknown';
  const decimals = results[2]?.status === 'success' ? (results[2].result as number)  : 18;
  const balance  = results[3]?.status === 'success' ? (results[3].result as bigint)  : 0n;

  return { symbol, name, decimals, balance };
}

/**
 * Read token balance + allowance for a spender in a single multicall.
 */
export async function getBalanceAndAllowanceMulticall(
  publicClient: PublicClient,
  tokenAddress: Address,
  walletAddress: Address,
  spenderAddress: Address,
): Promise<{ balance: bigint; allowance: bigint }> {
  const results = await publicClient.multicall({
    contracts: [
      { address: tokenAddress, abi: ERC20_ABI, functionName: 'balanceOf', args: [walletAddress] },
      { address: tokenAddress, abi: ERC20_ABI, functionName: 'allowance', args: [walletAddress, spenderAddress] },
    ],
    allowFailure: true,
  });

  const balance   = results[0]?.status === 'success' ? (results[0].result as bigint) : 0n;
  const allowance = results[1]?.status === 'success' ? (results[1].result as bigint) : 0n;

  return { balance, allowance };
}
