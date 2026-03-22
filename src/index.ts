import { loadConfig, setLogLevel, log } from "./config.js";
import { StateStore } from "./state/store.js";
import { WeixinClient } from "./weixin/client.js";
import { WeixinPoller } from "./weixin/poller.js";
import { performLogin } from "./weixin/login.js";
import { ClaudeBridge } from "./claude/bridge.js";
import { SessionManager } from "./claude/session.js";
import { BotController } from "./bot/controller.js";

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  log.info("Claude WeChat Bot starting...");

  const store = new StateStore(config.stateDir);
  const client = new WeixinClient(store.getToken() || "", config.wechat.baseUrl);

  // Login if no token
  if (!store.getToken() || process.argv.includes("--login")) {
    const token = await performLogin(client, store);
    client.setToken(token);
  }

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

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
