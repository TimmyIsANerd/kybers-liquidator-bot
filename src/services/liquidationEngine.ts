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
 *  5. Get KyberSwap calldata (with slippage-retry: auto-bumps on failure)
 *  6. Approve if needed (separate tx)
 *  7. Send swap tx, wait for receipt
 *  8. Notify user via Telegram
 *  9. Update session stats + learned slippage in MongoDB
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
import { getChain, getTransport, KYBER_NATIVE, USDT_ADDRESS } from '../config/chains.js';
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

// ─── Slippage Retry Config ────────────────────────────────────────────────────

const SLIPPAGE_BUMP     = 0.01;  // bump by 1% per retry
const SLIPPAGE_MAX      = 0.15;  // never exceed 15%
const SLIPPAGE_RETRIES  = 3;     // max retry attempts on slippage errors

/**
 * Returns true when an error message indicates a slippage / price-impact
 * failure from the DEX or the KyberSwap router.
 */
function isSlippageError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('slippage') ||
    lower.includes('insufficient output') ||
    lower.includes('insufficient_output_amount') ||
    lower.includes('price impact') ||
    lower.includes('minreturn') ||
    lower.includes('min_return') ||
    lower.includes('too little received') ||
    lower.includes('exceeds max') ||
    lower.includes('amount out is not sufficient') ||
    lower.includes('execution reverted') // generic revert often = slippage on DEX
  );
}

function getTargetTokenDecimals(tokenAddress: string, chainId: SupportedChain): number {
  if (tokenAddress.toLowerCase() === KYBER_NATIVE.toLowerCase()) {
    return 18;
  }
  const usdtAddr = USDT_ADDRESS[chainId];
  if (usdtAddr && tokenAddress.toLowerCase() === usdtAddr.toLowerCase()) {
    return chainId === SupportedChain.ETH ? 6 : 18;
  }
  return 18;
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

      if (session.sellPercentage && session.sellPercentage > 0) {
        const pct = Math.min(Math.max(session.sellPercentage, 1), 100);
        rawAmountIn = (balance * BigInt(Math.floor(pct * 100))) / 10000n;
        if (rawAmountIn === 0n && balance > 0n) {
          rawAmountIn = 1n;
        }
      } else {
        try {
          rawAmountIn = usdToTokenAmountRaw(session.usdAmountPerCycle, priceUsd, session.tokenDecimals);
        } catch {
          rawAmountIn = 0n;
        }
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

      // ── 5. KyberSwap: quote + build tx (with slippage-retry) ─────────────
      let effectiveSlippage = session.slippage;
      let tx!: Awaited<ReturnType<typeof getSwapCallData>>['tx'];
      let dstAmount = '0';
      let swapSucceeded = false;
      let slippageWasBumped = false;

      for (let attempt = 1; attempt <= SLIPPAGE_RETRIES + 1; attempt++) {
        try {
          const swapData = await getSwapCallData({
            chainId:  session.chainId,
            tokenIn:  session.tokenAddress,
            tokenOut: session.targetTokenAddress || KYBER_NATIVE,
            amountIn: rawAmountIn.toString(),
            from:     account.address,
            slippage: effectiveSlippage,
          });
          tx = swapData.tx;
          dstAmount = swapData.dstAmount;

          // ── 6. Approve if needed ─────────────────────────────────────────
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
            await publicClient.waitForTransactionReceipt({ hash: approvalHash });
            console.log(`[ENGINE] ✅ Approval confirmed: ${approvalHash}`);
          }

          // ── 7. Send swap tx ──────────────────────────────────────────────
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

          if (receipt.status === 'reverted') {
            throw new Error('Transaction reverted on-chain');
          }

          console.log(`[ENGINE] ✅ Confirmed in block ${receipt.blockNumber}`);

          // ── 8. Calculate amounts for notification ────────────────────────
          const soldTokenAmount = formatTokenAmount(rawAmountIn, session.tokenDecimals, 4);
          const targetSymbol    = session.targetTokenSymbol || nativeCurrency;
          const targetDecimals  = getTargetTokenDecimals(session.targetTokenAddress || KYBER_NATIVE, session.chainId);
          const receivedAmount  = formatUnits(BigInt(dstAmount || '0'), targetDecimals);
          const usdSold         = Number(rawAmountIn) / (10 ** session.tokenDecimals) * priceUsd;

          // ── 9. Update session stats + persist learned slippage ───────────
          session.lastRanAt    = Date.now();
          session.totalCycles  += 1;
          session.totalSoldUsd += usdSold;

          // Persist bumped slippage so future cycles start from learned value
          if (slippageWasBumped) {
            session.slippage = effectiveSlippage;
            console.log(`[ENGINE] 📚 Learned slippage saved: ${(effectiveSlippage * 100).toFixed(1)}%`);
          }

          // If we sold ALL remaining tokens or reached cycles limit, deactivate
          const isLastSell = rawAmountIn >= maxRawAmountIn;
          const isMaxCyclesReached = !!(session.maxCycles && session.totalCycles >= session.maxCycles);

          if (isLastSell || isMaxCyclesReached) {
            session.active = false;
            if (isLastSell) {
              session.pausedByLowBalance = true;
            }
            userData.liquidationSessions[sessionIndex] = session;
            await mongoStorage.write(userId, userData);
            this.stop(sessionId);
          } else {
            userData.liquidationSessions[sessionIndex] = session;
            await mongoStorage.write(userId, userData);
          }

          // ── 10. Notify success ───────────────────────────────────────────
          const txUrl = `${scanUrl}${txHash}`;
          let msg =
            `🎉 <b>Liquidation Complete!</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `💼 <b>Wallet:</b> <code>${account.address.slice(0, 6)}...${account.address.slice(-4)}</code>\n` +
            `🔗 <b>Chain:</b> ${chainName}\n` +
            `🪙 <b>Token:</b> ${esc(session.tokenSymbol)}\n` +
            `📤 <b>Sold:</b> ${soldTokenAmount} ${esc(session.tokenSymbol)} (~$${usdSold.toFixed(2)})\n` +
            `💰 <b>Received:</b> ${parseFloat(receivedAmount).toFixed(6)} ${targetSymbol}\n` +
            `🔗 <a href="${txUrl}">View Transaction</a>\n` +
            `📊 <b>Total Cycles:</b> ${session.totalCycles}${session.maxCycles ? `/${session.maxCycles}` : ''} | <b>Total Sold:</b> $${session.totalSoldUsd.toFixed(2)}\n`;

          if (isLastSell || isMaxCyclesReached) {
            // No next run time
          } else {
            msg += `⏰ <b>Next run in:</b> ${session.intervalMinutes} minutes`;
          }

          if (slippageWasBumped) {
            msg += `\n\n📚 <i>Slippage auto-adjusted to ${(session.slippage * 100).toFixed(1)}% (learned from failure)</i>`;
          }
          if (isLastSell) {
            msg += `\n\n⏸️ <b>Session auto-paused</b> — token balance depleted.`;
          } else if (isMaxCyclesReached) {
            msg += `\n\n🏁 <b>Session Completed</b> — reached maximum cycles limit of ${session.maxCycles}.`;
          }

          await this.notifyUser(bot, userId, msg);
          swapSucceeded = true;
          break; // ← exit retry loop

        } catch (swapErr: any) {
          const swapMsg = swapErr?.message || String(swapErr);
          console.warn(`[ENGINE] ⚠️ Swap attempt ${attempt} failed: ${swapMsg.slice(0, 120)}`);

          if (isSlippageError(swapMsg) && attempt <= SLIPPAGE_RETRIES) {
            const newSlippage = Math.min(effectiveSlippage + SLIPPAGE_BUMP, SLIPPAGE_MAX);
            console.log(
              `[ENGINE] 📈 Slippage error detected — bumping ${(effectiveSlippage * 100).toFixed(1)}% → ${(newSlippage * 100).toFixed(1)}% (retry ${attempt}/${SLIPPAGE_RETRIES})`,
            );

            await this.notifyUser(bot, userId,
              `🔄 <b>Slippage Retry</b>\n\n` +
              `🪙 Token: <b>${esc(session.tokenSymbol)}</b> | ${chainName}\n` +
              `📈 Bumping slippage: ${(effectiveSlippage * 100).toFixed(1)}% → ${(newSlippage * 100).toFixed(1)}%\n` +
              `<i>Attempt ${attempt} of ${SLIPPAGE_RETRIES}...</i>`,
            );

            effectiveSlippage = newSlippage;
            slippageWasBumped = true;
            await sleep(1500); // brief pause before retry
            continue;
          }

          // Not a slippage error or retries exhausted — propagate to outer catch
          throw swapErr;
        }
      }

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
