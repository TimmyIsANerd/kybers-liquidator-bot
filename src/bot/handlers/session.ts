/**
 * session.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Liquidation session setup wizard, view, pause, resume, and delete.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { InlineKeyboard } from 'grammy';
import type { BotContext, LiquidationSession, SupportedChain } from '../../types/index.js';
import { CHAIN_NAMES, CHAIN_CURRENCY } from '../../types/index.js';
import { resolveToken } from '../../services/tokenService.js';
import { decryptWallet, maskAddress } from '../../services/walletService.js';
import { liquidationEngine } from '../../services/liquidationEngine.js';
import { randomBytes } from 'node:crypto';

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function genId(): string {
  return randomBytes(8).toString('hex');
}

const INTERVAL_PRESETS = [5, 10, 15, 30, 60, 120];
const USD_PRESETS = [10, 25, 50, 100, 250, 500];

// ─── Step 1: Start setup — choose wallet ─────────────────────────────────────

export async function handleStartSessionSetup(ctx: BotContext): Promise<void> {
  const wallets = ctx.session.wallets ?? [];

  if (wallets.length === 0) {
    await ctx.reply(
      `⚠️ <b>No Wallets Found</b>\n\nYou need to add a wallet first before creating a session.`,
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .text('💼 Add Wallet', 'wallet:add')
          .text('❌ Cancel', 'nav:sessions'),
      },
    );
    return;
  }

  ctx.session.pendingSessionSetup = { step: 'chain' };

  const keyboard = new InlineKeyboard();
  wallets.forEach((w, i) => {
    keyboard.text(`💼 ${maskAddress(w.address)}`, `session:setup:wallet:${w.id}`).row();
  });
  keyboard.text('❌ Cancel', 'nav:sessions');

  const msg = await ctx.reply(
    `⚙️ <b>New Liquidation Session</b>\n\n` +
    `<b>Step 1 of 5:</b> Choose a wallet 💼\n\n` +
    `Which wallet should execute the liquidations?`,
    { parse_mode: 'HTML', reply_markup: keyboard },
  );
  ctx.session.pendingSessionSetup.promptMessageId = msg.message_id;
}

// ─── Step 2: Choose chain ─────────────────────────────────────────────────────

export async function handleSessionWalletChosen(ctx: BotContext, walletId: string): Promise<void> {
  if (!ctx.session.pendingSessionSetup) return;
  ctx.session.pendingSessionSetup.walletId = walletId;
  ctx.session.pendingSessionSetup.step = 'chain';

  const keyboard = new InlineKeyboard()
    .text('🔷 Ethereum (ETH)', 'session:setup:chain:1')
    .row()
    .text('🟡 BNB Chain (BSC)', 'session:setup:chain:56')
    .row()
    .text('❌ Cancel', 'nav:sessions');

  try {
    await ctx.editMessageText(
      `⚙️ <b>New Liquidation Session</b>\n\n` +
      `<b>Step 2 of 5:</b> Choose a chain 🔗\n\n` +
      `Which blockchain is your token on?`,
      { parse_mode: 'HTML', reply_markup: keyboard },
    );
  } catch {
    await ctx.reply(
      `⚙️ <b>Step 2 of 5:</b> Choose chain 🔗\n\nWhich blockchain?`,
      { parse_mode: 'HTML', reply_markup: keyboard },
    );
  }
}

// ─── Step 3: Enter token address ─────────────────────────────────────────────

export async function handleSessionChainChosen(ctx: BotContext, chainId: SupportedChain): Promise<void> {
  if (!ctx.session.pendingSessionSetup) return;
  ctx.session.pendingSessionSetup.chainId = chainId;
  ctx.session.pendingSessionSetup.step = 'token';

  const chainName = CHAIN_NAMES[chainId];

  const msg = await ctx.reply(
    `⚙️ <b>New Liquidation Session</b>\n\n` +
    `<b>Step 3 of 5:</b> Enter Token Address 🪙\n\n` +
    `Chain: <b>${chainName}</b>\n\n` +
    `Please send the <b>contract address</b> of the token you want to liquidate.\n\n` +
    `<i>Example: 0xabc123...</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('❌ Cancel', 'nav:sessions'),
    },
  );
  ctx.session.pendingSessionSetup.promptMessageId = msg.message_id;
}

// ─── Step 3b: Process token address ──────────────────────────────────────────

export async function processSessionTokenAddress(ctx: BotContext, address: string): Promise<void> {
  const setup = ctx.session.pendingSessionSetup;
  if (!setup || setup.step !== 'token' || !setup.chainId) return;

  // Delete prompt
  if (setup.promptMessageId) {
    try { await ctx.api.deleteMessage(ctx.chat!.id, setup.promptMessageId); } catch { /* ignore */ }
  }

  const loadingMsg = await ctx.reply(`🔍 <b>Looking up token info...</b>`, { parse_mode: 'HTML' });

  try {
    const tokenInfo = await resolveToken(address.trim(), setup.chainId);

    if (!tokenInfo) {
      await ctx.api.editMessageText(ctx.chat!.id, loadingMsg.message_id,
        `❌ <b>Token Not Found</b>\n\nCould not find token at <code>${esc(address)}</code> on ${CHAIN_NAMES[setup.chainId]}.\n\nPlease check the address and try again.`,
        { parse_mode: 'HTML' },
      );
      setup.step = 'token';
      return;
    }

    // Save token info
    setup.tokenAddress = address.trim();
    setup.tokenSymbol  = tokenInfo.symbol;
    setup.tokenName    = tokenInfo.name;
    setup.tokenLogo    = tokenInfo.logo;
    setup.tokenDecimals = tokenInfo.decimals;
    setup.step = 'usd_amount';

    // Build token info card
    const priceStr = tokenInfo.priceUsd ? `$${parseFloat(tokenInfo.priceUsd).toFixed(8)}` : 'N/A';
    const liqStr   = tokenInfo.liquidity ? `$${tokenInfo.liquidity.toLocaleString()}` : 'N/A';
    const mcStr    = tokenInfo.marketCap ? `$${tokenInfo.marketCap.toLocaleString()}` : 'N/A';

    const keyboard = new InlineKeyboard();
    USD_PRESETS.forEach((usd, i) => {
      keyboard.text(`$${usd}`, `session:setup:usd:${usd}`);
      if ((i + 1) % 3 === 0) keyboard.row();
    });
    keyboard.row().text('✏️ Custom Amount', 'session:setup:usd:custom').row();
    keyboard.text('❌ Cancel', 'nav:sessions');

    await ctx.api.editMessageText(ctx.chat!.id, loadingMsg.message_id,
      `✅ <b>Token Found!</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      (tokenInfo.logo ? `🖼️ <a href="${tokenInfo.logo}">View Logo</a>\n` : '') +
      `🪙 <b>Name:</b> ${esc(tokenInfo.name)}\n` +
      `📊 <b>Symbol:</b> ${esc(tokenInfo.symbol)}\n` +
      `🔢 <b>Decimals:</b> ${tokenInfo.decimals}\n` +
      `💵 <b>Price:</b> ${priceStr}\n` +
      `💧 <b>Liquidity:</b> ${liqStr}\n` +
      `📈 <b>Market Cap:</b> ${mcStr}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `<b>Step 4 of 5:</b> How much USD to sell per cycle? 💸`,
      { parse_mode: 'HTML', reply_markup: keyboard, link_preview_options: { is_disabled: true } },
    );
  } catch (err: any) {
    await ctx.api.editMessageText(ctx.chat!.id, loadingMsg.message_id,
      `❌ <b>Error:</b> ${esc(err.message)}\n\nPlease try again.`,
      { parse_mode: 'HTML' },
    );
  }
}

// ─── Step 4: USD Amount ───────────────────────────────────────────────────────

export async function handleSessionUsdAmount(ctx: BotContext, usdAmount: number): Promise<void> {
  const setup = ctx.session.pendingSessionSetup;
  if (!setup) return;
  setup.usdAmountPerCycle = usdAmount;
  setup.step = 'interval';

  const keyboard = new InlineKeyboard();
  INTERVAL_PRESETS.forEach((mins, i) => {
    const label = mins < 60 ? `${mins}m` : `${mins / 60}h`;
    keyboard.text(label, `session:setup:interval:${mins}`);
    if ((i + 1) % 3 === 0) keyboard.row();
  });
  keyboard.row().text('✏️ Custom Interval', 'session:setup:interval:custom').row();
  keyboard.text('❌ Cancel', 'nav:sessions');

  try {
    await ctx.editMessageText(
      `⚙️ <b>New Liquidation Session</b>\n\n` +
      `<b>Step 5 of 5:</b> Choose Interval ⏰\n\n` +
      `USD per cycle: <b>$${usdAmount}</b>\n\n` +
      `How often should the bot sell?\n` +
      `<i>Minimum: 5 minutes</i>`,
      { parse_mode: 'HTML', reply_markup: keyboard },
    );
  } catch {
    await ctx.reply(
      `<b>Step 5 of 5:</b> Choose Interval ⏰\n\nHow often should the bot sell?`,
      { parse_mode: 'HTML', reply_markup: keyboard },
    );
  }
}

// ─── Handle custom USD input ──────────────────────────────────────────────────

export async function processSessionCustomUsd(ctx: BotContext, text: string): Promise<void> {
  const setup = ctx.session.pendingSessionSetup;
  if (!setup || setup.step !== 'usd_amount') return;

  const amount = parseFloat(text);
  if (isNaN(amount) || amount <= 0) {
    await ctx.reply('❌ Please enter a valid USD amount (e.g. 50 or 100)', { parse_mode: 'HTML' });
    return;
  }

  await handleSessionUsdAmount(ctx, amount);
}

// ─── Step 5: Interval ─────────────────────────────────────────────────────────

export async function handleSessionInterval(ctx: BotContext, intervalMinutes: number): Promise<void> {
  const setup = ctx.session.pendingSessionSetup;
  if (!setup) return;

  if (intervalMinutes < 5) {
    await ctx.reply('❌ <b>Minimum interval is 5 minutes.</b>', { parse_mode: 'HTML' });
    return;
  }

  setup.intervalMinutes = intervalMinutes;
  setup.slippage = 0.01; // Default 1%
  setup.step = 'confirm';

  await showConfirmation(ctx);
}

export async function processSessionCustomInterval(ctx: BotContext, text: string): Promise<void> {
  const setup = ctx.session.pendingSessionSetup;
  if (!setup || setup.step !== 'interval') return;

  const mins = parseInt(text, 10);
  if (isNaN(mins) || mins < 5) {
    await ctx.reply('❌ Please enter a valid interval in minutes (minimum 5).', { parse_mode: 'HTML' });
    return;
  }

  await handleSessionInterval(ctx, mins);
}

// ─── Confirmation ─────────────────────────────────────────────────────────────

async function showConfirmation(ctx: BotContext): Promise<void> {
  const setup = ctx.session.pendingSessionSetup!;
  const wallets = ctx.session.wallets ?? [];
  const wallet = wallets.find(w => w.id === setup.walletId);

  const chainName     = CHAIN_NAMES[setup.chainId!];
  const nativeCurrency = CHAIN_CURRENCY[setup.chainId!];
  const intervalLabel = setup.intervalMinutes! < 60
    ? `${setup.intervalMinutes} minutes`
    : `${setup.intervalMinutes! / 60} hours`;

  const keyboard = new InlineKeyboard()
    .text('✅ Start Liquidating!', 'session:setup:confirm')
    .row()
    .text('🔧 Adjust Slippage (1%)', 'session:setup:slippage')
    .row()
    .text('❌ Cancel', 'nav:sessions');

  const text =
    `🎯 <b>Confirm Liquidation Session</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `💼 <b>Wallet:</b> <code>${wallet?.address ? maskAddress(wallet.address) : 'Unknown'}</code>\n` +
    `🔗 <b>Chain:</b> ${chainName}\n` +
    `🪙 <b>Token:</b> ${esc(setup.tokenName!)} (${esc(setup.tokenSymbol!)})\n` +
    `📍 <b>Contract:</b> <code>${setup.tokenAddress!.slice(0, 8)}...${setup.tokenAddress!.slice(-6)}</code>\n` +
    `💸 <b>USD per cycle:</b> $${setup.usdAmountPerCycle}\n` +
    `⏰ <b>Interval:</b> Every ${intervalLabel}\n` +
    `📉 <b>Slippage:</b> ${((setup.slippage ?? 0.01) * 100).toFixed(1)}%\n` +
    `🔀 <b>Swapping to:</b> ${nativeCurrency} via KyberSwap\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<i>Ready to start auto-selling? Hit the button below! 🚀</i>`;

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } catch {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

// ─── Finalize session ─────────────────────────────────────────────────────────

export async function handleConfirmSession(ctx: BotContext, bot: any): Promise<void> {
  const setup = ctx.session.pendingSessionSetup;
  if (!setup || setup.step !== 'confirm') return;

  const wallets = ctx.session.wallets ?? [];
  const encWallet = wallets.find(w => w.id === setup.walletId);
  if (!encWallet) {
    await ctx.reply('❌ Wallet not found. Please try again.', { parse_mode: 'HTML' });
    return;
  }

  const session: LiquidationSession = {
    id:               genId(),
    walletId:         setup.walletId!,
    chainId:          setup.chainId!,
    tokenAddress:     setup.tokenAddress!,
    tokenSymbol:      setup.tokenSymbol!,
    tokenName:        setup.tokenName!,
    tokenLogo:        setup.tokenLogo,
    tokenDecimals:    setup.tokenDecimals!,
    usdAmountPerCycle: setup.usdAmountPerCycle!,
    intervalMinutes:  setup.intervalMinutes!,
    slippage:         setup.slippage ?? 0.01,
    active:           true,
    createdAt:        Date.now(),
    totalSoldUsd:     0,
    totalCycles:      0,
  };

  if (!ctx.session.liquidationSessions) ctx.session.liquidationSessions = [];
  ctx.session.liquidationSessions.push(session);
  ctx.session.pendingSessionSetup = undefined;

  // Decrypt wallet and start engine
  try {
    const decrypted = decryptWallet(encWallet);
    const userId = ctx.from!.id.toString();
    liquidationEngine.start(bot, session, decrypted, userId);
  } catch (err: any) {
    console.error('[SESSION] Failed to start engine:', err);
  }

  const intervalLabel = session.intervalMinutes < 60
    ? `${session.intervalMinutes} minutes`
    : `${session.intervalMinutes / 60} hours`;

  await ctx.editMessageText(
    `🚀 <b>Liquidation Session Started!</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🟢 Status: <b>ACTIVE</b>\n` +
    `🪙 Token: <b>${esc(session.tokenSymbol)}</b>\n` +
    `💸 Selling: <b>$${session.usdAmountPerCycle}</b> every <b>${intervalLabel}</b>\n` +
    `🔗 Chain: ${CHAIN_NAMES[session.chainId]}\n\n` +
    `✅ You'll receive a notification after each successful sell.\n\n` +
    `<i>Use /sessions to view and manage your sessions.</i>`,
    { parse_mode: 'HTML' },
  );
}

// ─── View Sessions ────────────────────────────────────────────────────────────

export async function handleViewSessions(ctx: BotContext): Promise<void> {
  const sessions = ctx.session.liquidationSessions ?? [];

  if (sessions.length === 0) {
    await ctx.reply(
      `📋 <b>My Sessions</b>\n\nNo liquidation sessions yet!\n\nTap below to create one. 👇`,
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .text('➕ New Session', 'session:new')
          .text('⬅️ Back', 'nav:sessions'),
      },
    );
    return;
  }

  let text = `📋 <b>My Liquidation Sessions (${sessions.length})</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;

  sessions.forEach((s, i) => {
    const status = s.active && !s.pausedByLowBalance ? '🟢' : s.pausedByLowBalance ? '⚠️' : '🔴';
    const lastRan = s.lastRanAt ? new Date(s.lastRanAt).toLocaleString() : 'Never';
    const intervalLabel = s.intervalMinutes < 60 ? `${s.intervalMinutes}m` : `${s.intervalMinutes / 60}h`;

    text += `${status} <b>${esc(s.tokenSymbol)}</b> — ${CHAIN_NAMES[s.chainId]}\n`;
    text += `   💸 $${s.usdAmountPerCycle} every ${intervalLabel}\n`;
    text += `   📊 Cycles: ${s.totalCycles} | Total: $${s.totalSoldUsd.toFixed(2)}\n`;
    text += `   🕐 Last ran: ${lastRan}\n`;
    if (s.pausedByLowBalance) text += `   ⚠️ <i>Auto-paused (low balance)</i>\n`;
    text += `\n`;
  });

  const keyboard = new InlineKeyboard()
    .text('➕ Add Session', 'session:new')
    .text('🗑️ Delete', 'session:delete:menu')
    .row()
    .text('⏸️ Pause All', 'session:pause:all')
    .text('▶️ Resume All', 'session:resume:all')
    .row()
    .text('⬅️ Back', 'nav:sessions');

  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}

// ─── Activity Log ─────────────────────────────────────────────────────────────

export async function handleViewActivity(ctx: BotContext): Promise<void> {
  const sessions = ctx.session.liquidationSessions ?? [];

  if (sessions.length === 0) {
    await ctx.reply(`📊 <b>Activity</b>\n\nNo sessions yet.`, { parse_mode: 'HTML' });
    return;
  }

  let text = `📊 <b>Activity Summary</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  let totalCycles = 0;
  let totalUsd = 0;

  sessions.forEach(s => {
    totalCycles += s.totalCycles;
    totalUsd += s.totalSoldUsd;
    text += `🪙 <b>${esc(s.tokenSymbol)}</b> (${CHAIN_NAMES[s.chainId]})\n`;
    text += `   Cycles: ${s.totalCycles} | Sold: $${s.totalSoldUsd.toFixed(2)}\n\n`;
  });

  text += `━━━━━━━━━━━━━━━━━━━━\n`;
  text += `🔢 <b>Total Cycles:</b> ${totalCycles}\n`;
  text += `💰 <b>Total Liquidated:</b> $${totalUsd.toFixed(2)}`;

  await ctx.reply(text, {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard().text('⬅️ Back', 'nav:sessions'),
  });
}

// ─── Pause / Resume All ───────────────────────────────────────────────────────

export async function handlePauseAll(ctx: BotContext): Promise<void> {
  const sessions = ctx.session.liquidationSessions ?? [];
  let count = 0;
  for (const s of sessions) {
    if (s.active) {
      s.active = false;
      liquidationEngine.stop(s.id);
      count++;
    }
  }
  await ctx.reply(`⏸️ <b>Paused ${count} session(s).</b>`, { parse_mode: 'HTML' });
}

export async function handleResumeAll(ctx: BotContext, bot: any): Promise<void> {
  const sessions = ctx.session.liquidationSessions ?? [];
  const wallets = ctx.session.wallets ?? [];
  let count = 0;

  for (const s of sessions) {
    if (!s.active && !s.pausedByLowBalance) {
      s.active = true;
      const encWallet = wallets.find(w => w.id === s.walletId);
      if (encWallet) {
        try {
          const dec = decryptWallet(encWallet);
          liquidationEngine.start(bot, s, dec, ctx.from!.id.toString());
          count++;
        } catch (err) { console.error('Resume failed:', err); }
      }
    }
  }

  await ctx.reply(`▶️ <b>Resumed ${count} session(s).</b>`, { parse_mode: 'HTML' });
}

// ─── Delete Session ───────────────────────────────────────────────────────────

export async function handleDeleteSessionMenu(ctx: BotContext): Promise<void> {
  const sessions = ctx.session.liquidationSessions ?? [];
  if (sessions.length === 0) {
    await ctx.reply('No sessions to delete.', { parse_mode: 'HTML' });
    return;
  }

  const keyboard = new InlineKeyboard();
  sessions.forEach(s => {
    const label = `${s.tokenSymbol} (${CHAIN_NAMES[s.chainId]})`;
    keyboard.text(`🗑️ ${label}`, `session:delete:${s.id}`).row();
  });
  keyboard.text('❌ Cancel', 'nav:sessions');

  await ctx.reply('🗑️ <b>Delete Session</b>\n\nSelect a session to delete:', {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
}

export async function handleDeleteSession(ctx: BotContext, sessionId: string): Promise<void> {
  const sessions = ctx.session.liquidationSessions ?? [];
  const session = sessions.find(s => s.id === sessionId);
  if (!session) {
    await ctx.reply('❌ Session not found.', { parse_mode: 'HTML' });
    return;
  }

  liquidationEngine.stop(sessionId);
  ctx.session.liquidationSessions = sessions.filter(s => s.id !== sessionId);

  await ctx.reply(
    `✅ <b>Session Deleted</b>\n\n🪙 ${esc(session.tokenSymbol)} session removed.`,
    { parse_mode: 'HTML' },
  );
}
