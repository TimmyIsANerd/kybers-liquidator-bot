import { Menu } from '@grammyjs/menu';
import type { BotContext } from '../../types/index.js';

export const sessionsMenu = new Menu<BotContext>('sessions-menu')
  .text('➕ New Liquidation', async ctx => {
    const { handleStartSessionSetup } = await import('../handlers/session.js');
    return handleStartSessionSetup(ctx);
  })
  .row()
  .text('📋 Active Sessions', async ctx => {
    const { handleViewSessions } = await import('../handlers/session.js');
    return handleViewSessions(ctx);
  })
  .text('📊 Activity Log', async ctx => {
    const { handleViewActivity } = await import('../handlers/session.js');
    return handleViewActivity(ctx);
  })
  .row()
  .text('⏸️ Pause All', async ctx => {
    const { handlePauseAll } = await import('../handlers/session.js');
    return handlePauseAll(ctx);
  })
  .text('▶️ Resume All', async ctx => {
    const { handleResumeAll } = await import('../handlers/session.js');
    return handleResumeAll(ctx, null as any);
  })
  .row()
  .text('⬅️ Back to Dashboard', async ctx => {
    const { sendDashboard } = await import('../handlers/onboarding.js');
    return sendDashboard(ctx);
  });
