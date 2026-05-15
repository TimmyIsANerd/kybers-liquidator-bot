/**
 * liquidationEngine.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Core sell scheduler. Each active LiquidationSession gets its own interval.
 *
 * Per cycle:
 *  1. Multicall: read balance + allowance in one call
 *  2. Get live USD price from DexScreener
 *  3. Compute rawAmountIn = usdTarget / priceUsd
 *  4. Check native gas balance
 *  5. Get KyberSwap calldata
 *  6. Approve if needed (separate tx)
 *  7. Send swap tx, wait for receipt
 *  8. Notify user via Telegram
 *  9. Update session stats in MongoDB
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  parseUnits,
  type Address,
} from 'viem';
import type { Bot } from 'grammy';
import { privateKeyToAccount } from 'viem/accounts';
import type { BotContext, LiquidationSession, SessionData, Wallet } from '../types/index.js';
import { CHAIN_CURRENCY, CHAIN_NAMES, CHAIN_SCAN_URL, SupportedChain } from '../types/index.js';
import { getChain, getTransport, KYBER_NATIVE } from '../config/chains.js';
import { ERC20_ABI, getBalanceAndAllowanceMulticall } from '../libs/erc20.js';
import { getDexScreenerTokenInfo } from '../libs/dexScreener.js';
import { getSwapCallData } from './kyberSwapService.js';
import { decryptWallet, getAccountFromWallet } from './walletService.js';
import { formatTokenAmount, usdToTokenAmountRaw } from './tokenService.js';
import { mongoStorage } from '../storage/mongodb.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ActiveTimer {
  sessionId: string;
  userId: string;
  timer: ReturnType<typeof setInterval>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Engine ───────────────────────────────────────────────────────────────────

class LiquidationEngine {
  private timers = new Map<string, ActiveTimer>();

  // ── Start a session timer ──────────────────────────────────────────────────

  start(
    bot: Bot<BotContext>,
    session: LiquidationSession,
    wallet: Wallet,
    userId: string,
  ): void {
    if (this.timers.has(session.id)) {
      console.log(`[ENGINE] Session ${session.id} already running`);
      return;
    }

    const intervalMs = session.intervalMinutes * 60 * 1000;
    console.log(`[ENGINE] ▶️ Starting session ${session.id} (every ${session.intervalMinutes}m)`);

    const timer = setInterval(async () => {
      try {
        await this.runCycle(bot, session.id, wallet, userId);
      } catch (err) {
        console.error(`[ENGINE] Uncaught error in cycle for session ${session.id}:`, err);
      }
    }, intervalMs);

    this.timers.set(session.id, { sessionId: session.id, userId, timer });
  }

  // ── Stop a session timer ───────────────────────────────────────────────────

  stop(sessionId: string): void {
    const entry = this.timers.get(sessionId);
    if (entry) {
      clearInterval(entry.timer);
      this.timers.delete(sessionId);
      console.log(`[ENGINE] ⏹️ Stopped session ${sessionId}`);
    }
  }

  stopAll(): void {
    for (const [id] of this.timers) this.stop(id);
  }

  isRunning(sessionId: string): boolean {
    return this.timers.has(sessionId);
  }

  // ── Rehydrate sessions from MongoDB on bot startup ─────────────────────────

  async rehydrateFromDB(bot: Bot<BotContext>): Promise<void> {
    console.log('[ENGINE] 🔄 Rehydrating active sessions from MongoDB...');
    try {
      const allSessions = await mongoStorage.getAllSessions();
      let count = 0;

      for (const { userId, data } of allSessions) {
        if (!data.liquidationSessions?.length) continue;

        for (const session of data.liquidationSessions) {
          if (!session.active) continue;
          if (session.pausedByLowBalance) continue;

          const wallet = data.wallets?.find(w => w.id === session.walletId);
          if (!wallet) {
            console.warn(`[ENGINE] Wallet ${session.walletId} not found for session ${session.id}`);
            continue;
          }

          try {
            const decrypted = decryptWallet(wallet);
            this.start(bot, session, decrypted, userId);
            count++;
          } catch (err) {
            console.error(`[ENGINE] Failed to rehydrate session ${session.id}:`, err);
          }
        }
      }

      console.log(`[ENGINE] ✅ Rehydrated ${count} active sessions`);
    } catch (err) {
      console.error('[ENGINE] ❌ Rehydration failed:', err);
    }
  }

  // ── Core sell cycle ────────────────────────────────────────────────────────

  private async runCycle(
    bot: Bot<BotContext>,
    sessionId: string,
    wallet: Wallet,
    userId: string,
  ): Promise<void> {
    // Reload session fresh from DB to pick up any user changes (paused/deleted)
    const userData = await mongoStorage.read(userId);
    if (!userData) return;

    const sessionIndex = userData.liquidationSessions.findIndex(s => s.id === sessionId);
    if (sessionIndex === -1) {
      console.log(`[ENGINE] Session ${sessionId} no longer exists — stopping`);
      this.stop(sessionId);
      return;
    }

    const session = userData.liquidationSessions[sessionIndex];

    if (!session.active || session.pausedByLowBalance) {
      console.log(`[ENGINE] Session ${sessionId} is not active — stopping timer`);
      this.stop(sessionId);
      return;
    }

    const chain    = getChain(session.chainId);
    const transport = getTransport(session.chainId);
    const publicClient = createPublicClient({ chain, transport });

    const account = getAccountFromWallet(wallet);
    const walletClient = createWalletClient({ account, chain, transport });

    const nativeCurrency = CHAIN_CURRENCY[session.chainId];
    const chainName      = CHAIN_NAMES[session.chainId];
    const scanUrl        = CHAIN_SCAN_URL[session.chainId];

    console.log(`[ENGINE] 🔄 Cycle start — session ${sessionId} (${session.tokenSymbol} on ${chainName})`);

    try {
      // ── 1. Multicall: balance + allowance ──────────────────────────────────
      const kyberRouter = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';
      const { balance, allowance } = await getBalanceAndAllowanceMulticall(
        publicClient as any,
        session.tokenAddress as Address,
        account.address,
        kyberRouter as Address,
      );

      const formattedBalance = formatTokenAmount(balance, session.tokenDecimals);
      console.log(`[ENGINE] Token balance: ${formattedBalance} ${session.tokenSymbol}`);

      // ── 2. Get live price from DexScreener ─────────────────────────────────
      const tokenInfo = await getDexScreenerTokenInfo(session.tokenAddress, session.chainId);
      const priceUsd  = tokenInfo?.priceUsd ? parseFloat(tokenInfo.priceUsd) : null;

      if (!priceUsd || priceUsd <= 0) {
        await this.notifyUser(bot, userId,
          `⚠️ <b>Price Unavailable</b>\n\n` +
          `💼 Wallet: <code>${account.address}</code>\n` +
          `🔗 Chain: ${chainName}\n` +
          `🪙 Token: <b>${session.tokenSymbol}</b>\n\n` +
          `❌ Could not fetch token price from DexScreener.\n` +
          `🔄 Will retry next cycle in ${session.intervalMinutes} minutes.`,
        );
        return;
      }

      // ── 3. Compute rawAmountIn ────────────────────────────────────────────
      let rawAmountIn: bigint;
      const maxRawAmountIn = balance;

      try {
        rawAmountIn = usdToTokenAmountRaw(session.usdAmountPerCycle, priceUsd, session.tokenDecimals);
      } catch {
        rawAmountIn = 0n;
      }

      // If balance less than target amount — sell remaining or auto-pause
      if (balance === 0n) {
        // Auto-pause: no tokens left
        await this.pauseByLowBalance(userData, sessionIndex, userId);
        await this.notifyUser(bot, userId,
          `⏸️ <b>Session Auto-Paused</b>\n\n` +
          `💼 Wallet: <code>${account.address}</code>\n` +
          `🪙 Token: <b>${session.tokenSymbol}</b>\n` +
          `🔗 Chain: ${chainName}\n\n` +
          `❌ Token balance is zero. Session auto-paused.\n` +
          `💡 Top up your wallet or delete this session.`,
        );
        this.stop(sessionId);
        return;
      }

      if (rawAmountIn > maxRawAmountIn) {
        // Sell all remaining, then auto-pause
        rawAmountIn = maxRawAmountIn;
        console.log(`[ENGINE] Balance less than target — selling all remaining (${formattedBalance} ${session.tokenSymbol})`);
      }

      // ── 4. Check native gas balance ───────────────────────────────────────
      const nativeBalance = await publicClient.getBalance({ address: account.address });
      const MIN_GAS_WEI   = parseUnits('0.003', 18); // ~$8-12 worth of ETH/BNB for gas

      if (nativeBalance < MIN_GAS_WEI) {
        await this.notifyUser(bot, userId,
          `⛽ <b>Low Gas Warning!</b>\n\n` +
          `💼 Wallet: <code>${account.address}</code>\n` +
          `🔗 Chain: ${chainName}\n` +
          `❌ Insufficient ${nativeCurrency} for gas fees.\n` +
          `💰 Balance: <code>${formatUnits(nativeBalance, 18)} ${nativeCurrency}</code>\n\n` +
          `💡 Deposit some ${nativeCurrency} to continue.\n` +
          `🔄 Will retry next cycle in ${session.intervalMinutes} minutes.`,
        );
        return;
      }

      // ── 5. Get KyberSwap swap calldata ────────────────────────────────────
      const { tx, dstAmount } = await getSwapCallData({
        chainId:   session.chainId,
        tokenIn:   session.tokenAddress,
        tokenOut:  KYBER_NATIVE,
        amountIn:  rawAmountIn.toString(),
        from:      account.address,
        slippage:  session.slippage,
      });

      // ── 6. Approve if needed ──────────────────────────────────────────────
      if (allowance < rawAmountIn) {
        console.log(`[ENGINE] 🔓 Approving ${kyberRouter} for ${rawAmountIn}`);
        const approvalHash = await walletClient.writeContract({
          address: session.tokenAddress as Address,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [kyberRouter as Address, rawAmountIn * 2n],
          account,
          chain,
        });
        console.log(`[ENGINE] Approval tx: ${approvalHash}`);
        await publicClient.waitForTransactionReceipt({ hash: approvalHash });
        console.log(`[ENGINE] ✅ Approval confirmed`);
      }

      // ── 7. Send swap tx ───────────────────────────────────────────────────
      const txHash = await walletClient.sendTransaction({
        to:       tx.to,
        data:     tx.data,
        value:    tx.value,
        gas:      tx.gas,
        gasPrice: tx.gasPrice,
        account,
        chain,
      });

      console.log(`[ENGINE] 📤 Swap tx sent: ${txHash}`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      console.log(`[ENGINE] ✅ Confirmed in block ${receipt.blockNumber}`);

      // ── 8. Calculate amounts for notification ─────────────────────────────
      const soldTokenAmount = formatTokenAmount(rawAmountIn, session.tokenDecimals, 4);
      const receivedNative  = formatUnits(BigInt(dstAmount || '0'), 18);
      const approxUsd       = (rawAmountIn / BigInt(10 ** session.tokenDecimals)) * BigInt(Math.floor(priceUsd));
      const usdSold         = Number(rawAmountIn) / (10 ** session.tokenDecimals) * priceUsd;

      // ── 9. Update session stats ───────────────────────────────────────────
      session.lastRanAt    = Date.now();
      session.totalCycles  += 1;
      session.totalSoldUsd += usdSold;

      // If we sold ALL remaining tokens, auto-pause
      const isLastSell = rawAmountIn >= maxRawAmountIn;
      if (isLastSell) {
        await this.pauseByLowBalance(userData, sessionIndex, userId);
      } else {
        userData.liquidationSessions[sessionIndex] = session;
        await mongoStorage.write(userId, userData);
      }

      // ── 10. Notify success ────────────────────────────────────────────────
      const txUrl = `${scanUrl}${txHash}`;
      let msg =
        `🎉 <b>Liquidation Complete!</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `💼 <b>Wallet:</b> <code>${account.address.slice(0, 6)}...${account.address.slice(-4)}</code>\n` +
        `🔗 <b>Chain:</b> ${chainName}\n` +
        `🪙 <b>Token:</b> ${esc(session.tokenSymbol)}\n` +
        `📤 <b>Sold:</b> ${soldTokenAmount} ${esc(session.tokenSymbol)} (~$${usdSold.toFixed(2)})\n` +
        `💰 <b>Received:</b> ${parseFloat(receivedNative).toFixed(6)} ${nativeCurrency}\n` +
        `🔗 <a href="${txUrl}">View Transaction</a>\n` +
        `📊 <b>Total Cycles:</b> ${session.totalCycles} | <b>Total Sold:</b> $${session.totalSoldUsd.toFixed(2)}\n` +
        `⏰ <b>Next run in:</b> ${session.intervalMinutes} minutes`;

      if (isLastSell) {
        msg += `\n\n⏸️ <b>Session auto-paused</b> — token balance depleted.`;
      }

      await this.notifyUser(bot, userId, msg);

    } catch (err: any) {
      const message = err?.message || String(err);
      console.error(`[ENGINE] ❌ Cycle failed for session ${sessionId}:`, message);

      await this.notifyUser(bot, userId,
        `❌ <b>Liquidation Failed</b>\n\n` +
        `💼 Wallet: <code>${account.address.slice(0, 6)}...${account.address.slice(-4)}</code>\n` +
        `🪙 Token: <b>${esc(session.tokenSymbol)}</b>\n` +
        `🔗 Chain: ${chainName}\n\n` +
        `⚠️ Error: <i>${esc(message.slice(0, 200))}</i>\n\n` +
        `🔄 Will retry next cycle in ${session.intervalMinutes} minutes.`,
      );
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async notifyUser(bot: Bot<BotContext>, userId: string, message: string): Promise<void> {
    try {
      await bot.api.sendMessage(parseInt(userId), message, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      console.error(`[ENGINE] Failed to notify user ${userId}:`, err);
    }
  }

  private async pauseByLowBalance(
    userData: SessionData,
    sessionIndex: number,
    userId: string,
  ): Promise<void> {
    userData.liquidationSessions[sessionIndex].active = false;
    userData.liquidationSessions[sessionIndex].pausedByLowBalance = true;
    await mongoStorage.write(userId, userData);
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const liquidationEngine = new LiquidationEngine();
