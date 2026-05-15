/**
 * index.ts — Entry point
 */

import 'dotenv/config';
import { createBot } from './bot/bot.js';
import { mongoStorage } from './storage/mongodb.js';
import { liquidationEngine } from './services/liquidationEngine.js';

async function main(): Promise<void> {
  console.log('🚀 Kyber Liquidator Bot starting...');

  // 1. Connect to MongoDB
  await mongoStorage.connect();

  // 2. Create bot
  const bot = createBot();

  // 3. Rehydrate all active sessions from MongoDB
  await liquidationEngine.rehydrateFromDB(bot as any);

  // 4. Graceful shutdown
  const shutdown = async () => {
    console.log('\n🛑 Shutting down...');
    liquidationEngine.stopAll();
    await mongoStorage.disconnect();
    await bot.stop();
    console.log('✅ Shutdown complete');
    process.exit(0);
  };

  process.once('SIGINT',  shutdown);
  process.once('SIGTERM', shutdown);

  // 5. Start bot in long-polling mode
  await bot.start({
    drop_pending_updates: true,
    onStart: () => console.log('🤖 Kyber Liquidator Bot is running! Press Ctrl+C to stop.'),
  });
}

main().catch(err => {
  console.error('❌ Fatal startup error:', err);
  process.exit(1);
});
