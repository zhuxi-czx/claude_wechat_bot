import crypto from "node:crypto";
import path from "node:path";
import { log } from "../config.js";
import type { Config } from "../config.js";
import type { WeixinClient } from "../weixin/client.js";
import type { WeixinPoller } from "../weixin/poller.js";
import type { WeixinMessage } from "../weixin/types.js";
import { downloadImage } from "../weixin/cdn.js";
import type { ClaudeBridge } from "../claude/bridge.js";
import type { SessionManager } from "../claude/session.js";
import { chunkText } from "./chunker.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Find a natural break point (paragraph or line end) in the text. */
function findNaturalBreak(text: string): number {
  const paraIdx = text.lastIndexOf("\n\n");
  if (paraIdx > text.length * 0.3) return paraIdx + 2;
  const lineIdx = text.lastIndexOf("\n");
  if (lineIdx > text.length * 0.3) return lineIdx + 1;
  const sentenceMatch = text.match(/.*[.!?。！？]\s*/s);
  if (sentenceMatch && sentenceMatch[0].length > text.length * 0.3) {
    return sentenceMatch[0].length;
  }
  return 0;
}

/** Minimum interval between streaming chunk sends (ms). */
const STREAM_SEND_INTERVAL_MS = 5_000;
/** Send a "thinking" hint after this many ms of silence. */
const THINKING_HINT_DELAY_MS = 15_000;

export class BotController {
  private weixinClient: WeixinClient;
  private poller: WeixinPoller;
  private bridge: ClaudeBridge;
  private sessions: SessionManager;
  private config: Config;
  private userQueues = new Map<string, Promise<void>>();
  private typingTimers = new Map<string, ReturnType<typeof setInterval>>();
  /** Track which users have an active query so /stop can abort it. */
  private activeQuerySessions = new Map<string, string>();
  /** Cache typing ticket per user to avoid repeated getConfig calls. */
  private typingTickets = new Map<string, { ticket: string; botId: string }>();

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

    // Extract text and media content
    let text = "";
    let imagePath: string | null = null;

    if (msg.item_list) {
      for (const item of msg.item_list) {
        if (item.type === 1 && item.text_item?.text) {
          text += item.text_item.text;
        } else if (item.type === 3 && item.voice_item?.text) {
          text += item.voice_item.text;
        } else if (item.type === 2 && !imagePath) {
          // Download image from CDN
          const tempDir = path.join(this.config.stateDir, "media");
          imagePath = await downloadImage(item, tempDir);
        }
      }
      // Also check ref_msg for quoted images
      for (const item of msg.item_list) {
        if (item.ref_msg?.message_item?.type === 2 && !imagePath) {
          const tempDir = path.join(this.config.stateDir, "media");
          imagePath = await downloadImage(item.ref_msg.message_item, tempDir);
        }
      }
    }

    text = text.trim();

    // Build prompt: combine text and image reference
    if (imagePath) {
      if (text) {
        text = `${text}\n\n[The user sent an image. Read and analyze this image file: ${imagePath}]`;
      } else {
        text = `[The user sent an image. Read and analyze this image file: ${imagePath}]`;
      }
    }

    if (!text) {
      if (contextToken) {
        await this.sendReply(userId, "Sorry, I can only process text, voice, and image messages currently.", contextToken);
      }
      return;
    }

    // Store context token
    if (contextToken) {
      this.sessions.setContextToken(userId, contextToken);
    }

    log.info(`Message from ${userId}: ${text.slice(0, 100)}${text.length > 100 ? "..." : ""}`);

    // Handle /stop — abort running query for this user
    if (text === "/stop") {
      const activeSession = this.activeQuerySessions.get(userId);
      if (activeSession) {
        const aborted = this.bridge.abort(activeSession);
        await this.stopTyping(userId);
        if (contextToken) {
          await this.sendReply(userId, aborted ? "Query stopped." : "No active query to stop.", contextToken);
        }
      } else if (contextToken) {
        await this.sendReply(userId, "No active query to stop.", contextToken);
      }
      return;
    }

    // Handle other commands
    const cmdResult = this.handleCommand(text);
    if (cmdResult !== null) {
      if (contextToken) {
        await this.sendReply(userId, cmdResult, contextToken);
      }
      if (text === "/reset") {
        this.sessions.clearSession(userId);
      }
      return;
    }

    // Start typing indicator
    // typing API needs ilink_user_id = msg.to_user_id (the bot's own ID)
    const botId = msg.to_user_id || "";
    await this.startTyping(userId, botId, contextToken);

    try {
      const existingSessionId = this.sessions.getSessionId(userId);
      const resume = !!existingSessionId;
      const sessionId = existingSessionId || this.sessions.getOrCreateSessionId(userId);

      // Track active query for /stop support
      this.activeQuerySessions.set(userId, sessionId);

      const result = await this.streamQuery(userId, text, sessionId, resume);

      this.activeQuerySessions.delete(userId);

      if (result.session_id) {
        this.sessions.setSessionId(userId, result.session_id);
      }

      await this.stopTyping(userId, botId);
      log.info(`Reply sent to ${userId}, cost=$${result.total_cost_usd || 0}`);
    } catch (err) {
      this.activeQuerySessions.delete(userId);
      await this.stopTyping(userId, botId);
      log.error(`Claude query failed for ${userId}:`, err);

      const token = this.sessions.getContextToken(userId) || contextToken;
      if (token) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await this.sendReply(userId, `Sorry, an error occurred: ${errMsg.slice(0, 200)}`, token).catch(() => {});
      }
    }
  }

  /**
   * Stream Claude's response to WeChat.
   *
   * Strategy: use a single client_id with message_state updates:
   *   - GENERATING (1): intermediate updates showing partial text
   *   - FINISH (2): final complete response
   *
   * If the API doesn't support message updates (same client_id),
   * the user will simply see the final FINISH message.
   */
  private async streamQuery(
    userId: string,
    prompt: string,
    sessionId: string,
    resume: boolean,
  ): Promise<import("../claude/types.js").ClaudeResult> {
    const token = this.sessions.getContextToken(userId);
    if (!token) throw new Error("No context token");

    const gen = this.bridge.queryStream(prompt, sessionId, resume);
    let fullText = "";
    let lastSendTime = Date.now();
    let hintSent = false;

    // Single client_id for all updates to this response
    const streamClientId = crypto.randomUUID();

    // "Thinking..." hint timer
    const hintTimer = setTimeout(async () => {
      if (fullText.length === 0) {
        hintSent = true;
        // Send hint as GENERATING so it gets replaced by the real response
        await this.weixinClient.sendMessage(userId, "Thinking...", token, 1, streamClientId).catch(() => {});
      }
    }, THINKING_HINT_DELAY_MS);

    try {
      while (true) {
        const { value, done } = await gen.next();

        if (done) {
          const result = value;

          if (result.is_error) {
            await this.sendReply(userId, `Error: ${result.result}`, token);
            return result;
          }

          // Send final complete message with FINISH state
          const finalText = result.result || fullText || "(empty response)";
          const chunks = chunkText(finalText, this.config.wechat.maxMsgLength);

          // First chunk uses the stream client_id with FINISH to complete the update
          await this.weixinClient.sendMessage(userId, chunks[0], token, 2, streamClientId);

          // Additional chunks (if any) are separate messages
          for (let i = 1; i < chunks.length; i++) {
            await sleep(500);
            await this.sendReply(userId, chunks[i], token);
          }

          return result;
        }

        // Accumulate streamed text
        fullText += value;

        // Send intermediate update with GENERATING state
        const now = Date.now();
        const timeSinceSend = now - lastSendTime;

        if (timeSinceSend >= STREAM_SEND_INTERVAL_MS && fullText.length > 20) {
          await this.weixinClient.sendMessage(userId, fullText, token, 1, streamClientId).catch(() => {});
          lastSendTime = Date.now();
        }
      }
    } finally {
      clearTimeout(hintTimer);
    }
  }

  private handleCommand(text: string): string | null {
    if (text === "/help") {
      return [
        "Claude WeChat Bot Commands:",
        "",
        "/model         - Show current model",
        "/model <name>  - Switch model (opus/sonnet/haiku)",
        "/budget        - Show current budget",
        "/budget <n>    - Set max budget per query (USD)",
        "/system        - Show current system prompt",
        "/system <text> - Set system prompt",
        "/system clear  - Clear system prompt",
        "/stop          - Abort current query",
        "/reset         - Clear conversation history",
        "/help          - Show this message",
      ].join("\n");
    }

    if (text === "/reset") {
      return "Session cleared. Starting fresh.";
    }

    if (text === "/model") {
      return `Current model: ${this.bridge.config.model}`;
    }
    if (text.startsWith("/model ")) {
      const model = text.slice(7).trim();
      if (!model) return `Current model: ${this.bridge.config.model}`;
      this.bridge.config.model = model;
      log.info(`Model switched to: ${model}`);
      return `Model switched to: ${model}`;
    }

    if (text === "/budget") {
      return `Current max budget: $${this.bridge.config.maxBudget} per query`;
    }
    if (text.startsWith("/budget ")) {
      const val = parseFloat(text.slice(8).trim());
      if (isNaN(val) || val <= 0) return "Invalid budget value. Use a positive number, e.g. /budget 2.0";
      this.bridge.config.maxBudget = val;
      log.info(`Budget set to: $${val}`);
      return `Max budget set to: $${val} per query`;
    }

    if (text === "/system") {
      return this.bridge.config.systemPrompt
        ? `Current system prompt:\n${this.bridge.config.systemPrompt}`
        : "No system prompt set.";
    }
    if (text.startsWith("/system ")) {
      const prompt = text.slice(8).trim();
      if (prompt === "clear") {
        this.bridge.config.systemPrompt = undefined;
        return "System prompt cleared.";
      }
      this.bridge.config.systemPrompt = prompt;
      log.info(`System prompt updated`);
      return `System prompt set to:\n${prompt}`;
    }

    return null;
  }

  private async sendReply(userId: string, text: string, contextToken: string): Promise<void> {
    try {
      await this.weixinClient.sendMessage(userId, text, contextToken);
    } catch (err) {
      log.error(`Failed to send message to ${userId}:`, err);
    }
  }

  /**
   * Start typing indicator.
   * Key insight from openclaw-weixin: ilink_user_id must be the bot's own ID (msg.to_user_id),
   * not the sender's user ID. Keepalive every 5 seconds.
   */
  private async startTyping(userId: string, botId: string, contextToken?: string): Promise<void> {
    try {
      const token = contextToken || this.sessions.getContextToken(userId);
      if (!token || !botId) {
        log.debug(`startTyping: skipping, token=${!!token} botId=${botId}`);
        return;
      }

      // Get typing ticket (uses ilink_user_id = botId)
      const config = await this.weixinClient.getConfig(botId, token);
      if (!config.typing_ticket) {
        log.debug("startTyping: no typing_ticket returned");
        return;
      }

      const ticket = config.typing_ticket;
      this.typingTickets.set(userId, { ticket, botId });

      await this.weixinClient.sendTyping(botId, ticket, 1);
      log.debug(`startTyping: sent for botId=${botId}`);

      // Keepalive every 5 seconds (matching openclaw-weixin)
      const timer = setInterval(async () => {
        try {
          await this.weixinClient.sendTyping(botId, ticket, 1);
        } catch (err) {
          log.debug(`typing keepalive error: ${err}`);
        }
      }, 5_000);
      this.typingTimers.set(userId, timer);
    } catch (err) {
      log.debug(`startTyping failed: ${err}`);
    }
  }

  private async stopTyping(userId: string, botId?: string): Promise<void> {
    const timer = this.typingTimers.get(userId);
    if (timer) {
      clearInterval(timer);
      this.typingTimers.delete(userId);
    }

    const cached = this.typingTickets.get(userId);
    if (cached) {
      try {
        await this.weixinClient.sendTyping(cached.botId, cached.ticket, 2);
        log.debug(`stopTyping: sent cancel for botId=${cached.botId}`);
      } catch (err) {
        log.debug(`stopTyping failed: ${err}`);
      }
      this.typingTickets.delete(userId);
    }
  }
}
