import { log } from "../config.js";
import type { Config } from "../config.js";
import type { WeixinClient } from "../weixin/client.js";
import type { WeixinPoller } from "../weixin/poller.js";
import type { WeixinMessage } from "../weixin/types.js";
import type { ClaudeBridge } from "../claude/bridge.js";
import type { SessionManager } from "../claude/session.js";
import { chunkText } from "./chunker.js";

export class BotController {
  private weixinClient: WeixinClient;
  private poller: WeixinPoller;
  private bridge: ClaudeBridge;
  private sessions: SessionManager;
  private config: Config;
  private userQueues = new Map<string, Promise<void>>();
  private typingTimers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    weixinClient: WeixinClient,
    poller: WeixinPoller,
    bridge: ClaudeBridge,
    sessions: SessionManager,
    config: Config,
  ) {
    this.weixinClient = weixinClient;
    this.poller = poller;
    this.bridge = bridge;
    this.sessions = sessions;
    this.config = config;
  }

  async start(): Promise<void> {
    this.poller.on("message", (msg: WeixinMessage) => {
      this.enqueueMessage(msg);
    });

    this.poller.on("error", (err: Error) => {
      log.error("Poller error:", err.message);
    });

    this.poller.start();
    log.info("Bot controller started");
  }

  async stop(): Promise<void> {
    await this.poller.stop();
    this.bridge.abortAll();
    for (const timer of this.typingTimers.values()) {
      clearInterval(timer);
    }
    this.typingTimers.clear();
    log.info("Bot controller stopped");
  }

  private enqueueMessage(msg: WeixinMessage): void {
    const userId = msg.from_user_id;
    if (!userId) return;

    const prev = this.userQueues.get(userId) || Promise.resolve();
    const next = prev.then(() => this.handleMessage(msg)).catch((err) => {
      log.error(`Error handling message from ${userId}:`, err);
    });
    this.userQueues.set(userId, next);
  }

  private async handleMessage(msg: WeixinMessage): Promise<void> {
    const userId = msg.from_user_id!;
    const contextToken = msg.context_token;

    // Extract text content
    let text = "";
    if (msg.item_list) {
      for (const item of msg.item_list) {
        if (item.type === 1 && item.text_item?.text) {
          text += item.text_item.text;
        } else if (item.type === 3 && item.voice_item?.text) {
          text += item.voice_item.text;
        }
      }
    }

    text = text.trim();
    if (!text) {
      if (contextToken) {
        await this.sendReply(userId, "Sorry, I can only process text and voice messages currently.", contextToken);
      }
      return;
    }

    // Store context token
    if (contextToken) {
      this.sessions.setContextToken(userId, contextToken);
    }

    log.info(`Message from ${userId}: ${text.slice(0, 100)}${text.length > 100 ? "..." : ""}`);

    // Handle commands
    if (text === "/reset") {
      this.sessions.clearSession(userId);
      if (contextToken) {
        await this.sendReply(userId, "Session cleared. Starting fresh.", contextToken);
      }
      return;
    }

    if (text === "/help") {
      const helpText = [
        "Claude WeChat Bot Commands:",
        "/reset - Clear conversation history",
        "/help - Show this help message",
        "",
        "Send any text to chat with Claude.",
      ].join("\n");
      if (contextToken) {
        await this.sendReply(userId, helpText, contextToken);
      }
      return;
    }

    // Start typing indicator
    await this.startTyping(userId, contextToken);

    try {
      // Get or create session
      const existingSessionId = this.sessions.getSessionId(userId);
      const resume = !!existingSessionId;
      const sessionId = existingSessionId || this.sessions.getOrCreateSessionId(userId);

      // Query Claude
      const result = await this.bridge.query(text, sessionId, resume);

      // Update session with the returned session_id
      if (result.session_id) {
        this.sessions.setSessionId(userId, result.session_id);
      }

      // Stop typing
      await this.stopTyping(userId);

      // Send response
      const token = this.sessions.getContextToken(userId) || contextToken;
      if (!token) {
        log.error(`No context token for user ${userId}`);
        return;
      }

      if (result.is_error) {
        await this.sendReply(userId, `Error: ${result.result}`, token);
        return;
      }

      const responseText = result.result || "(empty response)";
      const chunks = chunkText(responseText, this.config.wechat.maxMsgLength);

      for (const chunk of chunks) {
        await this.sendReply(userId, chunk, token);
        // Small delay between chunks
        if (chunks.length > 1) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }

      log.info(`Reply sent to ${userId}, cost=$${result.total_cost_usd || 0}`);
    } catch (err) {
      await this.stopTyping(userId);
      log.error(`Claude query failed for ${userId}:`, err);

      const token = this.sessions.getContextToken(userId) || contextToken;
      if (token) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await this.sendReply(userId, `Sorry, an error occurred: ${errMsg.slice(0, 200)}`, token).catch(() => {});
      }
    }
  }

  private async sendReply(userId: string, text: string, contextToken: string): Promise<void> {
    try {
      await this.weixinClient.sendMessage(userId, text, contextToken);
    } catch (err) {
      log.error(`Failed to send message to ${userId}:`, err);
    }
  }

  private async startTyping(userId: string, contextToken?: string): Promise<void> {
    try {
      const token = contextToken || this.sessions.getContextToken(userId);
      if (!token) return;

      const config = await this.weixinClient.getConfig(userId, token);
      if (config.typing_ticket) {
        await this.weixinClient.sendTyping(userId, config.typing_ticket, 1);

        // Refresh typing every 15 seconds
        const timer = setInterval(async () => {
          try {
            await this.weixinClient.sendTyping(userId, config.typing_ticket!, 1);
          } catch {
            // ignore typing errors
          }
        }, 15_000);
        this.typingTimers.set(userId, timer);
      }
    } catch {
      // Typing indicator is best-effort
    }
  }

  private async stopTyping(userId: string): Promise<void> {
    const timer = this.typingTimers.get(userId);
    if (timer) {
      clearInterval(timer);
      this.typingTimers.delete(userId);
    }
    // Send cancel typing
    try {
      const token = this.sessions.getContextToken(userId);
      if (!token) return;
      const config = await this.weixinClient.getConfig(userId, token);
      if (config.typing_ticket) {
        await this.weixinClient.sendTyping(userId, config.typing_ticket, 2);
      }
    } catch {
      // ignore
    }
  }
}
