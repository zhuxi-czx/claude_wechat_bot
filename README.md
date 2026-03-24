# Claude WeChat Bot

> **Claude Code Bridge Series** by [zhuxi](https://github.com/zhuxi-czx) — Bridge Claude Code to any platform
>
> [**WeChat**](https://github.com/zhuxi-czx/claude_wechat_bot) · [Telegram](https://github.com/zhuxi-czx/claude_telegram_bot) · [Discord](https://github.com/zhuxi-czx/claude_discord_bot)

让 Claude Code 直接接入微信 —— 通过微信 ClawBot 开放能力，无需额外服务。

```
微信用户 ←→ 微信 ClawBot ←→ claude-wechat-bot ←→ Claude Code CLI（本地运行）
```

## 功能特性

- 文本对话：多轮上下文连续对话
- 图片识别：发送图片给 Claude 分析
- 流式回复：回复消息实时更新，无需等待完整生成
- 输入状态：处理时微信显示"对方正在输入"
- 运行时配置：在微信中切换模型、设置提示词

## 前提条件

1. **微信**：升级至 **V8.0.70** 及以上版本
2. 安装 [Node.js](https://nodejs.org/)（>= 18）
3. 安装并配置 [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)：

   ```bash
   # 安装 Claude Code
   npm install -g @anthropic-ai/claude-code

   # 首次运行，完成登录认证
   claude
   ```

4. **配置 Claude Code 权限**（重要）：

   本 bot 以非交互模式调用 Claude Code，需要预先信任工作目录。首次使用前，请在项目目录下运行一次 `claude` 命令，并在弹出的信任提示中选择信任该目录：

   ```bash
   cd claude_wechat_bot
   claude    # 选择信任此目录，然后退出即可
   ```

   如需 Claude 读取用户发送的图片，bot 会自动通过 `--add-dir` 授权媒体目录访问。

## 快速开始

```bash
# 克隆项目
git clone https://github.com/zhuxi-czx/claude_wechat_bot.git
cd claude_wechat_bot

# 安装依赖
npm install

# 信任工作目录（首次使用）
claude    # 在提示中选择信任，然后 Ctrl+C 退出

# 启动（首次运行会自动弹出二维码）
npm run dev
```

终端会显示一个二维码。打开微信，进入 **「我」→「设置」→「插件」→「微信 ClawBot」**，使用其中的扫一扫功能扫描终端二维码并确认，即可在微信中与 Claude 对话。

## 使用方式

```bash
npm run dev                        # 启动 bot（首次自动登录）
npx tsx src/cli.ts login           # 单独执行扫码绑定
npx tsx src/cli.ts logout          # 解除绑定
npx tsx src/cli.ts status          # 查看当前状态
```

### 后台运行

默认在前台运行，关闭终端服务会停止。如需后台常驻运行：

```bash
# 后台启动，日志输出到 bot.log
nohup npx tsx src/cli.ts start > bot.log 2>&1 & disown

# 查看日志
tail -f bot.log

# 检查是否在运行
pgrep -f "tsx src/cli.ts" && echo "running" || echo "stopped"

# 停止服务
kill $(pgrep -f "tsx src/cli.ts")
```

### 停止服务

前台运行时按 `Ctrl+C` 即可。

### 重新绑定微信

> **重要**：停止服务后 token 会失效，重启时需要重新扫码绑定。

```bash
# 1. 停止服务
kill $(pgrep -f "tsx src/cli.ts")

# 2. 清除旧凭证
npx tsx src/cli.ts logout

# 3. 前台启动并扫码（会自动弹出二维码）
npx tsx src/cli.ts start

# 4. 扫码成功后，Ctrl+C 停止前台进程，改为后台运行
nohup npx tsx src/cli.ts start > bot.log 2>&1 & disown
```

## 微信内可用命令

在微信对话中发送：

| 命令 | 说明 |
|---|---|
| `/model` | 查看当前模型 |
| `/model opus` | 切换模型（支持 opus / sonnet / haiku） |
| `/budget` | 查看当前单次预算 |
| `/budget 2.0` | 设置单次对话最大费用（美元） |
| `/system <提示词>` | 设置自定义系统提示词 |
| `/system clear` | 清除系统提示词 |
| `/stop` | 终止当前正在进行的查询 |
| `/reset` | 清除对话历史，重新开始 |
| `/help` | 查看所有命令 |

## 配置项

在项目根目录创建 `.env` 文件（可参考 `.env.example`）：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `CLAUDE_MODEL` | `sonnet` | Claude 模型：`opus` / `sonnet` / `haiku` |
| `CLAUDE_SYSTEM_PROMPT` | - | 自定义系统提示词 |
| `CLAUDE_MAX_BUDGET` | `1.0` | 单次对话最大费用（美元） |
| `CLAUDE_PERMISSION_MODE` | `default` | Claude CLI 权限模式（见下方说明） |
| `CLAUDE_ALLOWED_TOOLS` | - | 允许的工具白名单（逗号分隔） |
| `CLAUDE_TIMEOUT_MS` | `300000` | 单次查询超时（毫秒，默认 5 分钟） |
| `CLAUDE_MAX_CONCURRENT` | `3` | 最大并发 Claude 进程数 |
| `WECHAT_MAX_MSG_LENGTH` | `4000` | 单条微信消息最大字符数 |
| `STATE_DIR` | `./data` | 数据存储目录 |
| `LOG_LEVEL` | `info` | 日志级别：`debug` / `info` / `warn` / `error` |

### 关于 Claude 权限模式

`CLAUDE_PERMISSION_MODE` 控制 Claude Code 在处理消息时的工具使用权限：

- `default`（默认）— Claude 使用工具时遵循已有的权限设置。确保已在项目目录下运行过 `claude` 并信任目录
- `auto` — 自动推断并应用权限，更宽松

如果发现 Claude 回复中提示"权限不足"或无法读取文件，可以尝试将权限模式改为 `auto`：

```bash
echo "CLAUDE_PERMISSION_MODE=auto" >> .env
```

## 工作原理

1. **扫码绑定** — 调用微信 ClawBot API 生成二维码，微信扫码后获取 bot_token，保存到本地
2. **接收消息** — 通过长轮询（long-polling）持续获取微信用户发来的消息
3. **图片处理** — 用户发送图片时，从 CDN 下载并 AES-128-ECB 解密，保存为临时文件
4. **调用 Claude** — 将消息转发给本地 `claude` CLI 子进程处理，支持完整的 Claude Code 能力（包括图片分析）
5. **流式回复** — Claude 边生成边更新微信消息，使用 `message_state` 实现单条消息实时刷新
6. **多轮对话** — 每个微信用户维护独立的 Claude 会话，支持上下文连续对话

## 项目结构

```
src/
├── cli.ts                # CLI 入口（login/start/logout/status）
├── config.ts             # 配置加载
├── weixin/
│   ├── client.ts         # 微信 ClawBot API 客户端
│   ├── cdn.ts            # CDN 图片下载与 AES 解密
│   ├── login.ts          # 扫码登录流程
│   ├── poller.ts         # 消息长轮询
│   └── types.ts          # API 类型定义
├── claude/
│   ├── bridge.ts         # Claude Code CLI 子进程管理
│   ├── session.ts        # 用户会话管理
│   └── types.ts          # CLI 输出类型
├── bot/
│   ├── controller.ts     # 消息路由与编排
│   └── chunker.ts        # 长文本分片
└── state/
    └── store.ts          # 持久化存储
```

## 编译构建

```bash
npm run build    # 编译 TypeScript
npm start        # 运行编译后的版本
```

## 常见问题

**Q: Claude 提示权限不足，无法读取文件？**

在项目目录下运行 `claude` 命令并信任目录，或在 `.env` 中设置 `CLAUDE_PERMISSION_MODE=auto`。

**Q: 发送图片后 Claude 没有分析图片？**

确认 Claude Code 已认证且权限配置正确。图片会下载到 `data/media/` 目录，bot 通过 `--add-dir` 自动授权 Claude 访问该目录。

**Q: 重启后微信回复 "Error: undefined"？**

停止服务后 token 会失效。需要重新扫码绑定：`logout` → `start`（见上方"重新绑定微信"步骤）。

**Q: 启动后立即报 session timeout？**

这是正常现象，bot 会自动重试。如果持续失败，尝试 `logout` 后重新扫码。

**Q: 关闭终端后服务停了？**

使用 `nohup ... & disown` 方式后台运行（见上方"后台运行"步骤）。

## Related Projects

- [claude_telegram_bot](https://github.com/zhuxi-czx/claude_telegram_bot) — Bridge Claude Code to Telegram
- [claude_discord_bot](https://github.com/zhuxi-czx/claude_discord_bot) — Bridge Claude Code to Discord

## 反馈与联系

如有问题或建议，欢迎：

- 提交 [Issue](https://github.com/zhuxi-czx/claude_wechat_bot/issues)
- 发送邮件至 [zhuxi.czx@gmail.com](mailto:zhuxi.czx@gmail.com)

## License

MIT License - Copyright (c) 2026 [zhuxi](https://github.com/zhuxi-czx)
