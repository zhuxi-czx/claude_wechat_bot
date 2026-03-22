# Claude WeChat Bot

Bridge [Claude Code](https://claude.com/claude-code) CLI directly to WeChat via the ClawBot API.

```
WeChat User ←→ WeChat ClawBot API ←→ claude-wechat-bot ←→ Claude Code CLI
```

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Claude Code](https://claude.com/claude-code) CLI installed and authenticated

## Quick Start

```bash
# Step 1: Bind WeChat (scan QR code)
npx claude-wechat-bot login

# Step 2: Start the bot
npx claude-wechat-bot start
```

That's it. Scan the QR code with WeChat, and you'll be able to chat with Claude directly in WeChat.

## Commands

```bash
claude-wechat-bot login      # Scan QR code to bind WeChat
claude-wechat-bot start      # Start the bot (auto-login if needed)
claude-wechat-bot logout     # Clear saved credentials
claude-wechat-bot status     # Show current status
```

## Install Globally (Optional)

```bash
npm install -g claude-wechat-bot
claude-wechat-bot login
claude-wechat-bot start
```

## Configuration

All configuration is via environment variables or `.env` file:

| Variable | Default | Description |
|---|---|---|
| `CLAUDE_MODEL` | `sonnet` | Model: `opus`, `sonnet`, `haiku` |
| `CLAUDE_SYSTEM_PROMPT` | - | Custom system prompt |
| `CLAUDE_MAX_BUDGET` | `1.0` | Max cost per query (USD) |
| `CLAUDE_PERMISSION_MODE` | `default` | Claude CLI permission mode |
| `CLAUDE_ALLOWED_TOOLS` | - | Tool whitelist (comma-separated) |
| `WECHAT_MAX_MSG_LENGTH` | `4000` | Max chars per message |
| `STATE_DIR` | `./data` | Data directory |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

## WeChat Chat Commands

- `/reset` — Clear conversation history
- `/help` — Show commands

## How It Works

1. `login` calls the WeChat ClawBot API to generate a QR code
2. After scanning, a `bot_token` is saved locally
3. `start` begins long-polling for new WeChat messages
4. Each message is forwarded to `claude -p` (Claude Code CLI) as a subprocess
5. Claude's response is sent back to the WeChat user via `sendMessage` API
6. Per-user sessions are maintained via `--resume` for multi-turn conversations

## Development

```bash
git clone https://github.com/zhuxi-czx/claude_wechat_bot.git
cd claude_wechat_bot
npm install
npm run dev          # tsx hot-reload
npm run build        # compile TypeScript
npm start            # run compiled version
```

## License

MIT
