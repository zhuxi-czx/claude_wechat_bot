# Claude WeChat Bot

让 Claude Code 直接接入微信 —— 通过微信 ClawBot 开放能力，无需额外服务。

```
微信用户 ←→ 微信 ClawBot ←→ claude-wechat-bot ←→ Claude Code CLI（本地运行）
```

## 前提条件

1. **微信**：升级至 **V8.0.70** 及以上版本
2. 安装 [Node.js](https://nodejs.org/)（>= 18）
3. 安装 [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) 并完成认证：
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude  # 首次运行会引导登录认证
   ```

## 快速开始

```bash
# 克隆项目
git clone https://github.com/zhuxi-czx/claude_wechat_bot.git
cd claude_wechat_bot

# 安装依赖
npm install

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

### 重新绑定微信

```bash
npx tsx src/cli.ts logout          # 先解除
npx tsx src/cli.ts start           # 重新启动，会自动弹出新二维码
```

### 停止服务

按 `Ctrl+C` 即可。

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
| `/reset` | 清除对话历史，重新开始 |
| `/help` | 查看所有命令 |

## 配置项

在项目根目录创建 `.env` 文件（可参考 `.env.example`）：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `CLAUDE_MODEL` | `sonnet` | Claude 模型：`opus` / `sonnet` / `haiku` |
| `CLAUDE_SYSTEM_PROMPT` | - | 自定义系统提示词 |
| `CLAUDE_MAX_BUDGET` | `1.0` | 单次对话最大费用（美元） |
| `CLAUDE_PERMISSION_MODE` | `default` | Claude CLI 权限模式 |
| `CLAUDE_ALLOWED_TOOLS` | - | 允许的工具白名单（逗号分隔） |
| `WECHAT_MAX_MSG_LENGTH` | `4000` | 单条微信消息最大字符数 |
| `STATE_DIR` | `./data` | 数据存储目录 |
| `LOG_LEVEL` | `info` | 日志级别：`debug` / `info` / `warn` / `error` |

## 工作原理

1. **扫码绑定** — 调用微信 ClawBot API 生成二维码，微信扫码后获取 bot_token，保存到本地
2. **接收消息** — 通过长轮询（long-polling）持续获取微信用户发来的消息
3. **调用 Claude** — 将消息转发给本地 `claude` CLI 子进程处理，支持完整的 Claude Code 能力
4. **回复消息** — 将 Claude 的回复通过 ClawBot API 发回给微信用户
5. **多轮对话** — 每个微信用户维护独立的 Claude 会话，支持上下文连续对话

## 项目结构

```
src/
├── cli.ts                # CLI 入口（login/start/logout/status）
├── config.ts             # 配置加载
├── weixin/
│   ├── client.ts         # 微信 ClawBot API 客户端
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

## License

MIT
