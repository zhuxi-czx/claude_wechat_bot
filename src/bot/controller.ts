import { log } from "../config.js";
import type { Config } from "../config.js";
import type { WeixinClient } from "../weixin/client.js";
import type { WeixinPoller } from "../weixin/poller.js";
import type { WeixinMessage } from "../weixin/types.js";
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
   * Stream Claude's response, sending intermediate chunks to WeChat
   * so the user doesn't wait for the full response.
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
    let lastSentLength = 0;
    let lastSendTime = Date.now();

    // "Thinking..." hint timer
    const hintTimer = setTimeout(async () => {
      if (fullText.length === 0) {
        await this.sendReply(userId, "Thinking...", token).catch(() => {});
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

          // Send remaining unsent text
          const finalText = result.result || fullText;
          const unsent = finalText.slice(lastSentLength);

          if (unsent.trim()) {
            const chunks = chunkText(unsent, this.config.wechat.maxMsgLength);
            for (const chunk of chunks) {
              await this.sendReply(userId, chunk, token);
              if (chunks.length > 1) await sleep(500);
            }
          } else if (lastSentLength === 0) {
            // Nothing was ever sent
            const chunks = chunkText(finalText || "(empty response)", this.config.wechat.maxMsgLength);
            for (const chunk of chunks) {
              await this.sendReply(userId, chunk, token);
              if (chunks.length > 1) await sleep(500);
            }
          }

          return result;
        }

        // Accumulate streamed text
        fullText += value;

        // Send intermediate chunk if enough time and text accumulated
        const now = Date.now();
        const timeSinceSend = now - lastSendTime;
        const unsentLength = fullText.length - lastSentLength;

        if (timeSinceSend >= STREAM_SEND_INTERVAL_MS && unsentLength > 50) {
          const unsent = fullText.slice(lastSentLength);
          const breakIdx = findNaturalBreak(unsent);
          if (breakIdx > 0) {
            const toSend = unsent.slice(0, breakIdx);
            await this.sendReply(userId, toSend, token);
            lastSentLength += breakIdx;
            lastSendTime = Date.now();
          }
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
