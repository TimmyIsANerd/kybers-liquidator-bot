/**
 * onboarding.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * /start command, welcome message, and dashboard.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { InlineKeyboard } from 'grammy';
import type { BotContext } from '../../types/index.js';

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Send the main dashboard */
export async function sendDashboard(ctx: BotContext): Promise<void> {
  const wallets = ctx.session.wallets ?? [];
  const sessions = ctx.session.liquidationSessions ?? [];
  const activeSessions = sessions.filter(s => s.active && !s.pausedByLowBalance);
  const pausedSessions = sessions.filter(s => !s.active || s.pausedByLowBalance);

  const keyboard = new InlineKeyboard()
    .text('💼 My Wallets', 'nav:wallets')
    .text('⚙️ Sessions', 'nav:sessions')
    .row()
    .text('📊 Activity', 'nav:activity')
    .text('❓ Help', 'nav:help');

  const text =
    `🤖 <b>Kyber Liquidator Bot</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `👋 Welcome back!\n\n` +
    `📊 <b>Your Stats</b>\n` +
    `💼 Wallets: <b>${wallets.length}</b>\n` +
    `🟢 Active Sessions: <b>${activeSessions.length}</b>\n` +
    `⏸️ Paused Sessions: <b>${pausedSessions.length}</b>\n\n` +
    `<i>Select an option below to get started 👇</i>`;

  try {
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  } catch {
    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  }
}

/** Handle /start command */
export async function handleStart(ctx: BotContext): Promise<void> {
  // Ensure session defaults exist
  if (!ctx.session.wallets) ctx.session.wallets = [];
  if (!ctx.session.liquidationSessions) ctx.session.liquidationSessions = [];

  const isNewUser = ctx.session.wallets.length === 0;

  if (isNewUser) {
    await sendWelcome(ctx);
  } else {
    await sendDashboard(ctx);
  }
}

/** Welcome message for new users */
async function sendWelcome(ctx: BotContext): Promise<void> {
  const keyboard = new InlineKeyboard()
    .text('🔑 Import via Private Key', 'wallet:import:pk')
    .row()
    .text('🌿 Import via Seed Phrase', 'wallet:import:phrase')
    .row()
    .text('📖 How it works', 'nav:help');

  const text =
    `🚀 <b>Welcome to Kyber Liquidator Bot!</b>\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `💡 <b>What does this bot do?</b>\n` +
    `Automatically sells a fixed USD value of any token at regular intervals — using KyberSwap for best rates.\n\n` +
    `📌 <b>Example</b>\n` +
    `<i>"Sell $100 worth of KURURU every 10 minutes from my ETH wallet"</i>\n\n` +
    `🔗 <b>Supported Chains</b>\n` +
    `• 🔷 Ethereum (ETH)\n` +
    `• 🟡 BNB Chain (BSC)\n\n` +
    `🔐 <b>Security</b>\n` +
    `• Private keys are encrypted with AES-256-GCM\n` +
    `• Keys never leave your session\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `👇 <b>Let's get started! Import your first wallet:</b>`;

  await ctx.reply(text, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
}
