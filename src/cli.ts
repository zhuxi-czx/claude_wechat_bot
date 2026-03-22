#!/usr/bin/env node

import { loadConfig, setLogLevel, log } from "./config.js";
import { StateStore } from "./state/store.js";
import { WeixinClient } from "./weixin/client.js";
import { WeixinPoller } from "./weixin/poller.js";
import { performLogin } from "./weixin/login.js";
import { ClaudeBridge } from "./claude/bridge.js";
import { SessionManager } from "./claude/session.js";
import { BotController } from "./bot/controller.js";

const HELP = `
claude-wechat-bot — Bridge Claude Code to WeChat

Usage:
  claude-wechat-bot login        Scan QR code to bind WeChat
  claude-wechat-bot start        Start the bot (auto-login if needed)
  claude-wechat-bot logout       Clear saved credentials
  claude-wechat-bot status       Show current status
  claude-wechat-bot help         Show this help

Quick start:
  npx claude-wechat-bot login    # Scan QR to bind
  npx claude-wechat-bot start    # Run the bot

Environment variables (or .env file):
  CLAUDE_MODEL          Model to use (default: sonnet)
  CLAUDE_SYSTEM_PROMPT  Custom system prompt
  STATE_DIR             Data directory (default: ./data)
  LOG_LEVEL             debug/info/warn/error (default: info)
`;

async function cmdLogin(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  const store = new StateStore(config.stateDir);
  const client = new WeixinClient("", config.wechat.baseUrl);

  console.log("🔗 Claude WeChat Bot — Login\n");

  const token = await performLogin(client, store);
  client.setToken(token);

  console.log("\n✅ WeChat bound successfully!");
  console.log("Run `claude-wechat-bot start` to start the bot.\n");
}

async function cmdStart(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  const store = new StateStore(config.stateDir);
  const client = new WeixinClient(store.getToken() || "", config.wechat.baseUrl);

  // Auto-login if no token
  if (!store.getToken()) {
    console.log("No WeChat credentials found. Starting login...\n");
    const token = await performLogin(client, store);
    client.setToken(token);
    console.log();
  }

  log.info("Claude WeChat Bot starting...");

  const sessions = new SessionManager(store);
  const bridge = new ClaudeBridge(config.claude);
  const poller = new WeixinPoller(client, store);
  const controller = new BotController(client, poller, bridge, sessions, config);

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}, shutting down...`);
    await controller.stop();
    store.flush();
    log.info("Goodbye!");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await controller.start();
  log.info("Bot is running. Press Ctrl+C to stop.");
}

function cmdLogout(): void {
  const config = loadConfig();
  const store = new StateStore(config.stateDir);
  const token = store.getToken();

  if (!token) {
    console.log("No credentials found. Nothing to clear.");
    return;
  }

  store.setToken("");
  console.log("✅ Credentials cleared. Run `claude-wechat-bot login` to re-bind.");
}

function cmdStatus(): void {
  const config = loadConfig();
  const store = new StateStore(config.stateDir);
  const token = store.getToken();

  console.log("Claude WeChat Bot Status\n");
  console.log(`  WeChat:  ${token ? "✅ Bound" : "❌ Not bound"}`);
  console.log(`  Model:   ${config.claude.model}`);
  console.log(`  Data:    ${config.stateDir}`);
  console.log();

  if (!token) {
    console.log("Run `claude-wechat-bot login` to bind WeChat.");
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] || "help";

  switch (command) {
    case "login":
      await cmdLogin();
      break;
    case "start":
      await cmdStart();
      break;
    case "logout":
      cmdLogout();
      break;
    case "status":
      cmdStatus();
      break;
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
