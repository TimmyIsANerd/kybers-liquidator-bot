import { Menu } from '@grammyjs/menu';
import type { BotContext } from '../../types/index.js';

export const mainMenu = new Menu<BotContext>('main-menu')
  .text('💼 My Wallets', ctx => ctx.reply('wallets', { reply_markup: walletsMenuDef }))
  .text('⚙️ Sessions', ctx => ctx.reply('sessions', { reply_markup: sessionsMenuDef }))
  .row()
  .text('📊 Activity', async ctx => {
    const { handleViewActivity } = await import('../handlers/session.js');
    return handleViewActivity(ctx);
  })
  .text('❓ Help', async ctx => {
    await ctx.reply(
      `🤖 <b>Kyber Liquidator Bot — Help</b>\n\n` +
      `This bot automatically sells tokens at your chosen interval using KyberSwap.\n\n` +
      `<b>Commands:</b>\n` +
      `/start — Main dashboard\n` +
      `/wallets — Manage your wallets\n` +
      `/sessions — Manage liquidation sessions\n` +
      `/help — This message\n\n` +
      `<b>How it works:</b>\n` +
      `1. Add a wallet (private key or seed phrase)\n` +
      `2. Create a session: pick token, USD amount, interval\n` +
      `3. The bot sells automatically and notifies you each time ✅`,
      { parse_mode: 'HTML' },
    );
  });

// Forward refs (set after menus are created below)
let walletsMenuDef: any;
let sessionsMenuDef: any;

export function setSubMenuRefs(wallets: any, sessions: any) {
  walletsMenuDef = wallets;
  sessionsMenuDef = sessions;
}
