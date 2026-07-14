import type { Context, SessionFlavor } from 'grammy';
import type { ParseModeFlavor } from '@grammyjs/parse-mode';

// ─── Chains ──────────────────────────────────────────────────────────────────

export enum SupportedChain {
  ETH = 1,
  BSC = 56,
}

export const CHAIN_NAMES: Record<SupportedChain, string> = {
  [SupportedChain.ETH]: 'Ethereum',
  [SupportedChain.BSC]: 'BNB Chain',
};

export const CHAIN_CURRENCY: Record<SupportedChain, string> = {
  [SupportedChain.ETH]: 'ETH',
  [SupportedChain.BSC]: 'BNB',
};

export const CHAIN_SCAN_URL: Record<SupportedChain, string> = {
  [SupportedChain.ETH]: 'https://etherscan.io/tx/',
  [SupportedChain.BSC]: 'https://bscscan.com/tx/',
};

// ─── Wallet ───────────────────────────────────────────────────────────────────

export interface Wallet {
  id: string;
  address: string;
  /** AES-256-GCM encrypted private key */
  privateKey: string;
  /** AES-256-GCM encrypted mnemonic phrase (optional) */
  phrase?: string;
  label?: string;
  addedAt: number;
}

// ─── Liquidation Session ──────────────────────────────────────────────────────

export interface LiquidationSession {
  id: string;
  walletId: string;
  chainId: SupportedChain;
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  tokenLogo?: string;
  tokenDecimals: number;
  /** USD amount to sell per cycle */
  usdAmountPerCycle: number;
  /** Percentage of wallet token balance to sell per cycle (1-100) */
  sellPercentage?: number;
  /** Interval in minutes — minimum 5 */
  intervalMinutes: number;
  /** Slippage as decimal, e.g. 0.01 = 1% */
  slippage: number;
  active: boolean;
  createdAt: number;
  lastRanAt?: number;
  /** Cumulative USD value sold */
  totalSoldUsd: number;
  /** Total number of completed sell cycles */
  totalCycles: number;
  /** Paused by low balance (auto-pause) */
  pausedByLowBalance?: boolean;
  /** Target token address to swap to (e.g. KYBER_NATIVE or USDT) */
  targetTokenAddress?: string;
  /** Target token symbol (e.g. ETH, BNB, USDT) */
  targetTokenSymbol?: string;
  /** Max cycles/times to sell (0 or undefined for unlimited) */
  maxCycles?: number;
}

// ─── Session State (per-user wizard state) ────────────────────────────────────

export interface PendingWalletImport {
  method: 'pk' | 'phrase';
  promptMessageId?: number;
}

export interface PendingSessionSetup {
  step: 'chain' | 'token' | 'target_asset' | 'usd_amount' | 'sell_percentage' | 'max_cycles' | 'interval' | 'slippage' | 'confirm';
  walletId?: string;
  chainId?: SupportedChain;
  tokenAddress?: string;
  tokenSymbol?: string;
  tokenName?: string;
  tokenLogo?: string;
  tokenDecimals?: number;
  usdAmountPerCycle?: number;
  sellPercentage?: number;
  intervalMinutes?: number;
  slippage?: number;
  promptMessageId?: number;
  targetTokenAddress?: string;
  targetTokenSymbol?: string;
  maxCycles?: number;
}

// ─── Grammy Session Data ──────────────────────────────────────────────────────

export interface SessionData {
  wallets: Wallet[];
  liquidationSessions: LiquidationSession[];
  pendingWalletImport?: PendingWalletImport;
  pendingSessionSetup?: PendingSessionSetup;
  /** Track bot messages for cleanup */
  botMessageIds?: number[];
}

// ─── Bot Context ──────────────────────────────────────────────────────────────

export type BotContext = ParseModeFlavor<Context> & SessionFlavor<SessionData>;

// ─── DexScreener Token Info ───────────────────────────────────────────────────

export interface TokenInfo {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  logo?: string;
  priceUsd?: string;
  priceNative?: string;
  volume24h?: number;
  marketCap?: number;
  liquidity?: number;
}
