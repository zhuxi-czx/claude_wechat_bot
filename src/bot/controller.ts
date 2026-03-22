import { log } from "../config.js";
import type { Config } from "../config.js";
import type { WeixinClient } from "../weixin/client.js";
import type { WeixinPoller } from "../weixin/poller.js";
import type { WeixinMessage } from "../weixin/types.js";
import type { ClaudeBridge } from "../claude/bridge.js";
import type { SessionManager } from "../claude/session.js";
import { chunkText } from "./chunker.js";

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
    await this.startTyping(userId, contextToken);

    try {
      const existingSessionId = this.sessions.getSessionId(userId);
      const resume = !!existingSessionId;
      const sessionId = existingSessionId || this.sessions.getOrCreateSessionId(userId);

      // Stream query with periodic chunk sending
      const result = await this.streamQuery(userId, text, sessionId, resume);

      // Update session
      if (result.session_id) {
        this.sessions.setSessionId(userId, result.session_id);
      }

      await this.stopTyping(userId);
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
    let hintSent = false;

    // Set up a timer for the "thinking" hint
    const hintTimer = setTimeout(async () => {
      if (fullText.length === 0) {
        hintSent = true;
        await this.sendReply(userId, "Thinking...", token).catch(() => {});
      }
    }, THINKING_HINT_DELAY_MS);

    try {
      while (true) {
        const { value, done } = await gen.next();

        if (done) {
          clearTimeout(hintTimer);
          // value is ClaudeResult
          const result = value;
          const finalText = result.result || fullText;

          if (result.is_error) {
            await this.sendReply(userId, `Error: ${result.result}`, token);
            return result;
          }

          // Send any remaining unsent text
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

        // value is a text chunk
        fullText += value;

        // Send intermediate chunk if enough time has passed and enough text accumulated
        const now = Date.now();
        const timeSinceSend = now - lastSendTime;
        const unsentLength = fullText.length - lastSentLength;

        if (timeSinceSend >= STREAM_SEND_INTERVAL_MS && unsentLength > 50) {
          const unsent = fullText.slice(lastSentLength);
          // Only send at a natural break point
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
        "/reset         - Clear conversation history",
        "/stop          - Abort current query",
        "/help          - Show this message",
      ].join("\n");
    }

    if (text === "/reset") {
      return "Session cleared. Starting fresh.";
    }

    if (text === "/stop") {
      // Will be handled by abort logic via session
      return "Stopping current query...";
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

  private async startTyping(userId: string, contextToken?: string): Promise<void> {
    try {
      const token = contextToken || this.sessions.getContextToken(userId);
      if (!token) return;

      const config = await this.weixinClient.getConfig(userId, token);
      if (config.typing_ticket) {
        await this.weixinClient.sendTyping(userId, config.typing_ticket, 1);

        const timer = setInterval(async () => {
          try {
            await this.weixinClient.sendTyping(userId, config.typing_ticket!, 1);
          } catch {
            // ignore
          }
        }, 15_000);
        this.typingTimers.set(userId, timer);
      }
    } catch {
      // best-effort
    }
  }

  private async stopTyping(userId: string): Promise<void> {
    const timer = this.typingTimers.get(userId);
    if (timer) {
      clearInterval(timer);
      this.typingTimers.delete(userId);
    }
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Find a natural break point (paragraph or line end) in the text. */
function findNaturalBreak(text: string): number {
  // Prefer paragraph break
  const paraIdx = text.lastIndexOf("\n\n");
  if (paraIdx > text.length * 0.3) return paraIdx + 2;

  // Fallback to line break
  const lineIdx = text.lastIndexOf("\n");
  if (lineIdx > text.length * 0.3) return lineIdx + 1;

  // Fallback to sentence end
  const sentenceMatch = text.match(/.*[.!?。！？]\s*/s);
  if (sentenceMatch && sentenceMatch[0].length > text.length * 0.3) {
    return sentenceMatch[0].length;
  }

  return 0;
}
