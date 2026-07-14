/**
 * bot.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Grammy bot setup: session, menus, command handlers, callback router.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Bot, session } from 'grammy';
import { hydrateReply, parseMode } from '@grammyjs/parse-mode';
import type { BotContext, SessionData } from '../types/index.js';
import { SupportedChain } from '../types/index.js';
import { mongoStorage } from '../storage/mongodb.js';
import { liquidationEngine } from '../services/liquidationEngine.js';

// ── Handlers ──────────────────────────────────────────────────────────────────
import { handleStart, sendDashboard } from './handlers/onboarding.js';
import {
  handleStartPKImport,
  handleStartPhraseImport,
  processWalletImport,
  handleListWallets,
  handleRemoveWalletMenu,
  handleRemoveWallet,
} from './handlers/wallet.js';
import {
  handleStartSessionSetup,
  handleSessionWalletChosen,
  handleSessionChainChosen,
  processSessionTokenAddress,
  handleSessionTargetChosen,
  handleSessionUsdAmount,
  handleSessionCyclesChosen,
  processSessionCustomCycles,
  handleSessionInterval,
  processSessionCustomUsd,
  processSessionCustomInterval,
  handleConfirmSession,
  handleViewSessions,
  handleViewActivity,
  handlePauseAll,
  handleResumeAll,
  handleDeleteSessionMenu,
  handleDeleteSession,
} from './handlers/session.js';

// ─── Default Session ──────────────────────────────────────────────────────────

function defaultSession(): SessionData {
  return {
    wallets: [],
    liquidationSessions: [],
  };
}

// ─── Bot Factory ──────────────────────────────────────────────────────────────

export function createBot(): Bot<BotContext> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');

  const bot = new Bot<BotContext>(token);

  // ── Plugins ────────────────────────────────────────────────────────────────
  bot.use(hydrateReply);
  bot.api.config.use(parseMode('HTML'));

  // ── Session ────────────────────────────────────────────────────────────────
  bot.use(session({
    initial: defaultSession,
    storage: mongoStorage,
    getSessionKey: ctx => ctx.from?.id.toString(),
  }));

  // ── Debug middleware ───────────────────────────────────────────────────────
  bot.use(async (ctx, next) => {
    const update = ctx.update.update_id;
    const text   = (ctx.message?.text || '').slice(0, 50);
    console.log(`[BOT] Update ${update} — "${text}"`);
    try {
      await next();
    } catch (err: any) {
      console.error(`[BOT] Error in update ${update}:`, err.message);
    }
  });

  // ── Commands ───────────────────────────────────────────────────────────────

  bot.command('start', handleStart);

  bot.command('wallets', async ctx => {
    await handleListWallets(ctx);
  });

  bot.command('sessions', async ctx => {
    await handleViewSessions(ctx);
  });

  bot.command('help', async ctx => {
    await ctx.reply(
      `🤖 <b>Kyber Liquidator Bot</b>\n\n` +
      `<b>Commands:</b>\n` +
      `/start — Dashboard\n` +
      `/wallets — Manage wallets\n` +
      `/sessions — Manage liquidation sessions\n` +
      `/help — This message\n\n` +
      `<b>How it works:</b>\n` +
      `1. Add your wallet (private key or seed phrase)\n` +
      `2. Create a session: choose token, amount, interval\n` +
      `3. Bot sells automatically every interval using KyberSwap 🔄\n` +
      `4. Get notified on every sell ✅`,
      { parse_mode: 'HTML' },
    );
  });

  // ── Callback Router ────────────────────────────────────────────────────────

  bot.on('callback_query:data', async ctx => {
    const data = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery(); // Always answer to prevent spinning

    // Navigation
    if (data === 'nav:dashboard') { return sendDashboard(ctx); }
    if (data === 'nav:help') {
      return ctx.reply(
        `🤖 <b>Kyber Liquidator Bot</b>\n\n<b>Commands:</b>\n/start — Dashboard\n/wallets — Manage wallets\n/sessions — Manage sessions\n/help — This message\n\n<b>How it works:</b>\n1. Add your wallet (private key or seed phrase)\n2. Create a session: choose token, amount, interval\n3. Bot sells automatically every interval using KyberSwap 🔄\n4. Get notified on every sell ✅`,
        { parse_mode: 'HTML' },
      );
    }
    if (data === 'nav:wallets' || data === 'wallet:add') {
      return ctx.reply(
        `💼 <b>Wallet Manager</b>\n\nWhat would you like to do?`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔑 Import via Private Key', callback_data: 'wallet:import:pk' }],
              [{ text: '🌿 Import via Seed Phrase', callback_data: 'wallet:import:phrase' }],
              [
                { text: '📋 View Wallets', callback_data: 'wallet:list' },
                { text: '🗑️ Remove', callback_data: 'wallet:remove' },
              ],
              [{ text: '⬅️ Dashboard', callback_data: 'nav:dashboard' }],
            ],
          },
        },
      );
    }
    if (data === 'nav:sessions') {
      return ctx.reply(
        `⚙️ <b>Sessions Manager</b>\n\nManage your liquidation sessions:`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '➕ New Liquidation', callback_data: 'session:new' }],
              [
                { text: '📋 Active Sessions', callback_data: 'session:list' },
                { text: '📊 Activity', callback_data: 'nav:activity' },
              ],
              [
                { text: '⏸️ Pause All', callback_data: 'session:pause:all' },
                { text: '▶️ Resume All', callback_data: 'session:resume:all' },
              ],
              [{ text: '⬅️ Dashboard', callback_data: 'nav:dashboard' }],
            ],
          },
        },
      );
    }
    if (data === 'nav:activity') { return handleViewActivity(ctx); }

    // Wallet callbacks
    if (data === 'wallet:import:pk')    { return handleStartPKImport(ctx); }
    if (data === 'wallet:import:phrase') { return handleStartPhraseImport(ctx); }
    if (data === 'wallet:list')          { return handleListWallets(ctx); }
    if (data === 'wallet:remove')        { return handleRemoveWalletMenu(ctx); }
    if (data.startsWith('wallet:remove:')) {
      const walletId = data.replace('wallet:remove:', '');
      return handleRemoveWallet(ctx, walletId);
    }

    // Session setup callbacks
    if (data === 'session:new')     { return handleStartSessionSetup(ctx); }
    if (data === 'session:list')    { return handleViewSessions(ctx); }
    if (data === 'session:pause:all')  { return handlePauseAll(ctx); }
    if (data === 'session:resume:all') { return handleResumeAll(ctx, bot); }
    if (data === 'session:delete:menu') { return handleDeleteSessionMenu(ctx); }
    if (data.startsWith('session:delete:')) {
      const sessionId = data.replace('session:delete:', '');
      return handleDeleteSession(ctx, sessionId);
    }

    // Wizard: wallet chosen
    if (data.startsWith('session:setup:wallet:')) {
      const walletId = data.replace('session:setup:wallet:', '');
      return handleSessionWalletChosen(ctx, walletId);
    }

    // Wizard: chain chosen
    if (data.startsWith('session:setup:chain:')) {
      const chainId = parseInt(data.replace('session:setup:chain:', '')) as SupportedChain;
      return handleSessionChainChosen(ctx, chainId);
    }

    // Wizard: target chosen
    if (data.startsWith('session:setup:target:')) {
      const target = data.replace('session:setup:target:', '') as 'native' | 'usdt';
      return handleSessionTargetChosen(ctx, target);
    }

    // Wizard: USD amount preset
    if (data.startsWith('session:setup:usd:')) {
      const val = data.replace('session:setup:usd:', '');
      if (val === 'custom') {
        if (ctx.session.pendingSessionSetup) {
          ctx.session.pendingSessionSetup.step = 'usd_amount';
        }
        const msg = await ctx.reply(
          `✏️ <b>Custom USD Amount</b>\n\nEnter the USD amount to sell per cycle (e.g. 75):`,
          { parse_mode: 'HTML' },
        );
        if (ctx.session.pendingSessionSetup) {
          ctx.session.pendingSessionSetup.promptMessageId = msg.message_id;
        }
        return;
      }
      return handleSessionUsdAmount(ctx, parseFloat(val));
    }

    // Wizard: cycles preset
    if (data.startsWith('session:setup:cycles:')) {
      const val = data.replace('session:setup:cycles:', '');
      if (val === 'custom') {
        if (ctx.session.pendingSessionSetup) {
          ctx.session.pendingSessionSetup.step = 'max_cycles';
        }
        const msg = await ctx.reply(
          `✏️ <b>Custom Cycle Limit</b>\n\nEnter the number of cycles to execute (e.g. 15, or 0 for unlimited):`,
          { parse_mode: 'HTML' },
        );
        if (ctx.session.pendingSessionSetup) {
          ctx.session.pendingSessionSetup.promptMessageId = msg.message_id;
        }
        return;
      }
      return handleSessionCyclesChosen(ctx, parseInt(val, 10));
    }

    // Wizard: interval preset
    if (data.startsWith('session:setup:interval:')) {
      const val = data.replace('session:setup:interval:', '');
      if (val === 'custom') {
        if (ctx.session.pendingSessionSetup) {
          ctx.session.pendingSessionSetup.step = 'interval';
        }
        const msg = await ctx.reply(
          `✏️ <b>Custom Interval</b>\n\nEnter interval in minutes (minimum 5):`,
          { parse_mode: 'HTML' },
        );
        if (ctx.session.pendingSessionSetup) {
          ctx.session.pendingSessionSetup.promptMessageId = msg.message_id;
        }
        return;
      }
      return handleSessionInterval(ctx, parseInt(val));
    }

    // Wizard: confirm
    if (data === 'session:setup:confirm') {
      return handleConfirmSession(ctx, bot);
    }

    // Wizard: slippage adjustment
    if (data === 'session:setup:slippage') {
      const keyboard = {
        inline_keyboard: [
          [
            { text: '0.5%', callback_data: 'session:slippage:0.005' },
            { text: '1%', callback_data: 'session:slippage:0.01' },
            { text: '2%', callback_data: 'session:slippage:0.02' },
          ],
          [
            { text: '3%', callback_data: 'session:slippage:0.03' },
            { text: '5%', callback_data: 'session:slippage:0.05' },
            { text: '10%', callback_data: 'session:slippage:0.10' },
          ],
        ],
      };
      return ctx.reply('📉 <b>Set Slippage</b>\n\nChoose slippage tolerance:', {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    }
    if (data.startsWith('session:slippage:')) {
      const val = parseFloat(data.replace('session:slippage:', ''));
      if (ctx.session.pendingSessionSetup) {
        ctx.session.pendingSessionSetup.slippage = val;
      }
      await ctx.reply(`✅ Slippage set to ${(val * 100).toFixed(1)}%`, { parse_mode: 'HTML' });
      // Re-show confirmation
      const { showConfirmation } = await import('./handlers/session.js') as any;
      if (typeof showConfirmation === 'function') return showConfirmation(ctx);
    }

    console.log(`[BOT] Unhandled callback: ${data}`);
  });

  // ── Text Message Router ────────────────────────────────────────────────────

  bot.on('message:text', async ctx => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return; // Skip commands

    // Wallet import flow
    if (ctx.session.pendingWalletImport) {
      return processWalletImport(ctx, text);
    }

    // Session setup: token address input
    const setup = ctx.session.pendingSessionSetup;
    if (setup) {
      if (setup.step === 'token' && /^0x[0-9a-fA-F]{40}$/.test(text.trim())) {
        return processSessionTokenAddress(ctx, text.trim());
      }
      if (setup.step === 'usd_amount') {
        return processSessionCustomUsd(ctx, text.trim());
      }
      if (setup.step === 'max_cycles') {
        return processSessionCustomCycles(ctx, text.trim());
      }
      if (setup.step === 'interval') {
        return processSessionCustomInterval(ctx, text.trim());
      }
      // If user sends token-like address during token step
      if (setup.step === 'token') {
        await ctx.reply('❌ Please send a valid contract address (starts with 0x, 42 chars).');
        return;
      }
    }

    // Default: guide user
    await ctx.reply(
      `🤖 Use /start to open the dashboard, or /help for more info.`,
      { parse_mode: 'HTML' },
    );
  });

  // ── Error handler ──────────────────────────────────────────────────────────
  bot.catch(err => {
    const desc = (err as any)?.error?.description || '';
    if (typeof desc === 'string' && desc.includes('message is not modified')) return;
    console.error('[BOT] Unhandled error:', err);
  });

  return bot;
}
