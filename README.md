# Claude WeChat Bot

Bridge [Claude Code](https://claude.com/claude-code) CLI directly to WeChat via the ClawBot API. No OpenClaw dependency required.

## How It Works

```
WeChat User ←→ WeChat ClawBot API ←→ claude_wechat_bot ←→ Claude Code CLI
```

1. The bot connects to WeChat using the ClawBot API (long-polling for messages)
2. When a user sends a message, it spawns a `claude` CLI subprocess
3. Claude's response is sent back to the WeChat user
4. Multi-turn conversations are maintained per user via Claude Code's session resumption

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Claude Code](https://claude.com/claude-code) CLI installed and authenticated (`claude` command available)
- A WeChat account for QR code login

## Quick Start

```bash
# Clone
git clone https://github.com/zhuxi-czx/claude_wechat_bot.git
cd claude_wechat_bot

# Install dependencies
npm install

# Copy and edit config (optional)
cp .env.example .env

# Start the bot (will show QR code on first run)
npm run dev
```

Scan the QR code with WeChat to connect. The bot will start receiving and responding to messages.

## Configuration

All configuration is via environment variables (or `.env` file):

| Variable | Default | Description |
|---|---|---|
| `CLAUDE_MODEL` | `sonnet` | Claude model: `opus`, `sonnet`, `haiku` |
| `CLAUDE_SYSTEM_PROMPT` | - | Custom system prompt |
| `CLAUDE_MAX_BUDGET` | `1.0` | Max cost per query (USD) |
| `CLAUDE_PERMISSION_MODE` | `default` | Permission mode for Claude CLI |
| `CLAUDE_ALLOWED_TOOLS` | - | Comma-separated tool whitelist |
| `WECHAT_BASE_URL` | `https://ilinkai.weixin.qq.com` | WeChat API base URL |
| `WECHAT_MAX_MSG_LENGTH` | `4000` | Max chars per message |
| `STATE_DIR` | `./data` | State persistence directory |
| `LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |

## Chat Commands

- `/reset` - Clear conversation history and start fresh
- `/help` - Show available commands

## Build

```bash
npm run build    # Compile TypeScript
npm start        # Run compiled version
```

## Re-login

```bash
npm run dev -- --login
```

## Architecture

```
src/
├── index.ts              # Entry point
├── config.ts             # Configuration
├── weixin/
│   ├── client.ts         # WeChat HTTP API client
│   ├── login.ts          # QR code login flow
│   ├── poller.ts         # Long-poll message loop
│   └── types.ts          # API type definitions
├── claude/
│   ├── bridge.ts         # Claude CLI subprocess manager
│   ├── session.ts        # Per-user session tracking
│   └── types.ts          # CLI output types
├── bot/
│   ├── controller.ts     # Message routing & orchestration
│   └── chunker.ts        # Long text splitting
└── state/
    └── store.ts          # Persistent state (token, sessions)
```

## License

MIT
