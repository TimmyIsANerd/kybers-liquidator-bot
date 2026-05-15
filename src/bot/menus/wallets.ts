import { Menu } from '@grammyjs/menu';
import type { BotContext } from '../../types/index.js';

export const walletsMenu = new Menu<BotContext>('wallets-menu')
  .text('🔑 Import via Private Key', async ctx => {
    const { handleStartPKImport } = await import('../handlers/wallet.js');
    return handleStartPKImport(ctx);
  })
  .row()
  .text('🌿 Import via Seed Phrase', async ctx => {
    const { handleStartPhraseImport } = await import('../handlers/wallet.js');
    return handleStartPhraseImport(ctx);
  })
  .row()
  .text('📋 View My Wallets', async ctx => {
    const { handleListWallets } = await import('../handlers/wallet.js');
    return handleListWallets(ctx);
  })
  .text('🗑️ Remove Wallet', async ctx => {
    const { handleRemoveWalletMenu } = await import('../handlers/wallet.js');
    return handleRemoveWalletMenu(ctx);
  })
  .row()
  .text('⬅️ Back to Dashboard', async ctx => {
    const { sendDashboard } = await import('../handlers/onboarding.js');
    return sendDashboard(ctx);
  });
