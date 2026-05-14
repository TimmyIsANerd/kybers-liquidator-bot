# Kyber Liquidator Bot

A Telegram bot that liquidates (sells) user-specified amounts of tokens at regular intervals using KyberSwap.

## Features
- **Onboarding Flow**: Welcome message and secure wallet import (Private Key or Mnemonic).
- **Multi-Wallet Support**: Connect multiple wallets and manage liquidations for each.
- **Liquidation Scheduler**: Automatically sells a fixed USD amount of tokens for ETH at chosen intervals.
- **KyberSwap Integration**: Uses KyberSwap Aggregator for best routing and gas efficiency.
- **Secure**: Private keys and mnemonics are encrypted at rest using AES-256-CTR.
- **Token Verification**: Verifies user holdings before setting up a liquidation task.

## Setup

1. **Install Dependencies**:
   ```bash
   bun install
   ```

2. **Configure Environment**:
   Copy `.env.example` to `.env` and fill in your details:
   - `TELEGRAM_BOT_TOKEN`: Get it from [@BotFather](https://t.me/BotFather).
   - `RPC_URL`: An Ethereum RPC URL (e.g., Alchemy, Infura, or LlamaRPC).
   - `ENCRYPTION_KEY`: A strong secret string for encrypting wallet keys.

3. **Run the Bot**:
   ```bash
   bun run src/index.ts
   ```

## Modular Structure
- `src/bot`: Telegram bot handlers and menus.
- `src/services`: Core logic (KyberSwap, Wallet management, Token checks).
- `src/storage`: SQLite database management.
- `src/config.ts`: Global configuration.

## Technologies
- **Runtime**: [Bun](https://bun.sh)
- **Bot Framework**: [grammY](https://grammy.dev)
- **Blockchain**: [viem](https://viem.sh)
- **Database**: [SQLite](https://bun.sh/docs/api/sqlite)
