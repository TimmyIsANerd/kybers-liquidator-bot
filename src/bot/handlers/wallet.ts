/**
 * wallet.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wallet import, list, and remove handlers.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { InlineKeyboard } from 'grammy';
import type { BotContext } from '../../types/index.js';
import {
  createWalletFromPrivateKey,
  createWalletFromMnemonic,
  encryptWallet,
  decryptWallet,
  maskAddress,
  isValidPrivateKey,
  isValidMnemonic,
} from '../../services/walletService.js';

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Import Starters ──────────────────────────────────────────────────────────

export async function handleStartPKImport(ctx: BotContext): Promise<void> {
  ctx.session.pendingWalletImport = { method: 'pk' };

  const msg = await ctx.reply(
    `🔑 <b>Import Wallet via Private Key</b>\n\n` +
    `Please send your private key in the next message.\n\n` +
    `⚠️ <i>Your key is encrypted with AES-256-GCM before being stored.</i>\n` +
    `⚠️ <i>Never share your private key with anyone else.</i>`,
    { parse_mode: 'HTML' },
  );
  ctx.session.pendingWalletImport.promptMessageId = msg.message_id;
}

export async function handleStartPhraseImport(ctx: BotContext): Promise<void> {
  ctx.session.pendingWalletImport = { method: 'phrase' };

  const msg = await ctx.reply(
    `🌿 <b>Import Wallet via Seed Phrase</b>\n\n` +
    `Please send your 12 or 24 word seed phrase in the next message.\n\n` +
    `⚠️ <i>Your phrase is encrypted with AES-256-GCM before being stored.</i>\n` +
    `⚠️ <i>Never share your seed phrase with anyone else.</i>`,
    { parse_mode: 'HTML' },
  );
  ctx.session.pendingWalletImport.promptMessageId = msg.message_id;
}

// ─── Process Import ───────────────────────────────────────────────────────────

export async function processWalletImport(ctx: BotContext, text: string): Promise<void> {
  const pending = ctx.session.pendingWalletImport;
  if (!pending) return;

  // Delete prompt message for security
  if (pending.promptMessageId) {
    try { await ctx.api.deleteMessage(ctx.chat!.id, pending.promptMessageId); } catch { /* ignore */ }
  }
  // Delete user's message containing the key
  try { await ctx.deleteMessage(); } catch { /* ignore */ }

  ctx.session.pendingWalletImport = undefined;

  const method = pending.method;
  let wallet;

  try {
    if (method === 'pk') {
      if (!isValidPrivateKey(text)) {
        await ctx.reply('❌ <b>Invalid private key.</b> Please check and try again.', { parse_mode: 'HTML' });
        return;
      }
      wallet = createWalletFromPrivateKey(text.trim());
    } else {
      if (!isValidMnemonic(text)) {
        await ctx.reply('❌ <b>Invalid seed phrase.</b> Please check the words and try again.', { parse_mode: 'HTML' });
        return;
      }
      wallet = createWalletFromMnemonic(text.trim());
    }
  } catch (err: any) {
    await ctx.reply(`❌ <b>Error:</b> ${esc(err.message)}`, { parse_mode: 'HTML' });
    return;
  }

  // ── Guard 1: Check if another user already owns this wallet (cross-user) ──
  const { mongoStorage } = await import('../../storage/mongodb.js');
  const userId = ctx.from!.id.toString();
  const globalCheck = await mongoStorage.isWalletAddressTaken(wallet.address, userId);

  if (globalCheck.taken) {
    await ctx.reply(
      `🚫 <b>Wallet Already In Use</b>\n\n` +
      `<code>${wallet.address}</code>\n\n` +
      `This wallet is already registered by another user and cannot be imported again.`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  // ── Guard 2: Check within the current user's own wallet list ──────────────
  const existing = (ctx.session.wallets ?? []).find(w => {
    try {
      const dec = decryptWallet(w);
      return dec.address.toLowerCase() === wallet!.address.toLowerCase();
    } catch { return false; }
  });

  if (existing) {
    await ctx.reply(
      `⚠️ <b>Wallet Already Added</b>\n\n` +
      `<code>${wallet.address}</code>\n` +
      `This wallet is already in your account.`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  // Encrypt and save
  const encrypted = encryptWallet(wallet);
  if (!ctx.session.wallets) ctx.session.wallets = [];
  ctx.session.wallets.push(encrypted);

  const keyboard = new InlineKeyboard()
    .text('⚙️ Set Up Liquidation', 'session:new')
    .row()
    .text('💼 View Wallets', 'wallet:list')
    .text('🏠 Dashboard', 'nav:dashboard');

  await ctx.reply(
    `✅ <b>Wallet Imported Successfully!</b>\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📍 Address: <code>${wallet.address}</code>\n` +
    `🔐 Method: ${method === 'pk' ? '🔑 Private Key' : '🌿 Seed Phrase'}\n` +
    `🔒 Encrypted: AES-256-GCM ✅\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<i>What would you like to do next?</i>`,
    { parse_mode: 'HTML', reply_markup: keyboard },
  );
}

// ─── List Wallets ─────────────────────────────────────────────────────────────

export async function handleListWallets(ctx: BotContext): Promise<void> {
  const wallets = ctx.session.wallets ?? [];

  if (wallets.length === 0) {
    const keyboard = new InlineKeyboard()
      .text('🔑 Import via Private Key', 'wallet:import:pk')
      .row()
      .text('🌿 Import via Seed Phrase', 'wallet:import:phrase');

    await ctx.reply(
      `💼 <b>My Wallets</b>\n\n` +
      `You haven't added any wallets yet.\n` +
      `Import one to get started! 👇`,
      { parse_mode: 'HTML', reply_markup: keyboard },
    );
    return;
  }

  let text = `💼 <b>My Wallets (${wallets.length})</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  wallets.forEach((w, i) => {
    let addr = w.address;
    text += `${i + 1}. <code>${addr}</code>\n`;
    if (w.label) text += `   📝 ${esc(w.label)}\n`;
    text += `   📅 Added: ${new Date(w.addedAt).toLocaleDateString()}\n\n`;
  });

  const keyboard = new InlineKeyboard()
    .text('➕ Add Another', 'wallet:add')
    .text('🗑️ Remove', 'wallet:remove')
    .row()
    .text('⬅️ Back', 'nav:dashboard');

  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}

// ─── Remove Wallet ────────────────────────────────────────────────────────────

export async function handleRemoveWalletMenu(ctx: BotContext): Promise<void> {
  const wallets = ctx.session.wallets ?? [];

  if (wallets.length === 0) {
    await ctx.reply('💼 You have no wallets to remove.', { parse_mode: 'HTML' });
    return;
  }

  const keyboard = new InlineKeyboard();
  wallets.forEach((w, i) => {
    keyboard.text(`🗑️ ${maskAddress(w.address)}`, `wallet:remove:${w.id}`).row();
  });
  keyboard.text('❌ Cancel', 'nav:wallets');

  await ctx.reply(
    `🗑️ <b>Remove Wallet</b>\n\n` +
    `Select a wallet to remove.\n` +
    `⚠️ <i>This will also stop all associated liquidation sessions.</i>`,
    { parse_mode: 'HTML', reply_markup: keyboard },
  );
}

export async function handleRemoveWallet(ctx: BotContext, walletId: string): Promise<void> {
  const wallets = ctx.session.wallets ?? [];
  const index = wallets.findIndex(w => w.id === walletId);

  if (index === -1) {
    await ctx.reply('❌ Wallet not found.', { parse_mode: 'HTML' });
    return;
  }

  const wallet = wallets[index];

  // Stop and remove all sessions tied to this wallet
  const sessions = ctx.session.liquidationSessions ?? [];
  const { liquidationEngine } = await import('../../services/liquidationEngine.js');

  const removedSessions = sessions.filter(s => s.walletId === walletId);
  for (const s of removedSessions) {
    liquidationEngine.stop(s.id);
  }
  ctx.session.liquidationSessions = sessions.filter(s => s.walletId !== walletId);
  ctx.session.wallets = wallets.filter(w => w.id !== walletId);

  await ctx.reply(
    `✅ <b>Wallet Removed</b>\n\n` +
    `Address: <code>${wallet.address}</code>\n` +
    `Stopped sessions: <b>${removedSessions.length}</b>`,
    { parse_mode: 'HTML' },
  );
}
