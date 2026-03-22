import crypto from "node:crypto";
import { log } from "../config.js";
import type {
  BaseInfo,
  GetUpdatesResponse,
  GetConfigResponse,
  QrCodeResponse,
  QrCodeStatusResponse,
} from "./types.js";

const CHANNEL_VERSION = "1.0.0";
const DEFAULT_LONG_POLL_TIMEOUT_MS = 38_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const QR_LONG_POLL_TIMEOUT_MS = 35_000;

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildBaseInfo(): BaseInfo {
  return { channel_version: CHANNEL_VERSION };
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

export class WeixinClient {
  private token: string;
  private baseUrl: string;

  constructor(token: string, baseUrl = "https://ilinkai.weixin.qq.com") {
    this.token = token;
    this.baseUrl = baseUrl;
  }

  setToken(token: string): void {
    this.token = token;
  }

  private buildHeaders(bodyLength: number): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "Content-Length": String(bodyLength),
      "X-WECHAT-UIN": randomWechatUin(),
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    return headers;
  }

  private async post<T>(endpoint: string, body: object, timeoutMs = DEFAULT_API_TIMEOUT_MS): Promise<T> {
    const base = ensureTrailingSlash(this.baseUrl);
    const url = new URL(endpoint, base).toString();
    const bodyStr = JSON.stringify(body);
    const headers = this.buildHeaders(Buffer.byteLength(bodyStr, "utf-8"));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      log.debug(`POST ${endpoint}`);
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: bodyStr,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      return JSON.parse(text) as T;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  async getUpdates(buf: string): Promise<GetUpdatesResponse> {
    try {
      return await this.post<GetUpdatesResponse>(
        "ilink/bot/getupdates",
        { get_updates_buf: buf, base_info: buildBaseInfo() },
        DEFAULT_LONG_POLL_TIMEOUT_MS,
      );
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        log.debug("getUpdates: long-poll timeout, returning empty");
        return { ret: 0, msgs: [], get_updates_buf: buf };
      }
      throw err;
    }
  }

  async sendMessage(
    toUserId: string,
    text: string,
    contextToken: string,
    messageState: number = 2,
    clientId?: string,
  ): Promise<string> {
    const id = clientId || crypto.randomUUID();
    await this.post("ilink/bot/sendmessage", {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: id,
        message_type: 2, // BOT
        message_state: messageState,
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      },
      base_info: buildBaseInfo(),
    });
    return id;
  }

  async getConfig(userId: string, contextToken?: string): Promise<GetConfigResponse> {
    return this.post<GetConfigResponse>("ilink/bot/getconfig", {
      ilink_user_id: userId,
      context_token: contextToken,
      base_info: buildBaseInfo(),
    });
  }

  async sendTyping(userId: string, typingTicket: string, status: 1 | 2): Promise<void> {
    await this.post("ilink/bot/sendtyping", {
      ilink_user_id: userId,
      typing_ticket: typingTicket,
      status,
      base_info: buildBaseInfo(),
    });
  }

  // ---- QR Login API ----

  async fetchQrCode(baseUrl?: string): Promise<QrCodeResponse> {
    const base = ensureTrailingSlash(baseUrl || this.baseUrl);
    const url = new URL("ilink/bot/get_bot_qrcode?bot_type=3", base).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_API_TIMEOUT_MS);

    try {
      log.debug("Fetching QR code...");
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Failed to fetch QR code: ${res.status} ${body}`);
      }
      return (await res.json()) as QrCodeResponse;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  async pollQrStatus(qrcode: string, baseUrl?: string): Promise<QrCodeStatusResponse> {
    const base = ensureTrailingSlash(baseUrl || this.baseUrl);
    const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, base).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), QR_LONG_POLL_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        headers: { "iLink-App-ClientVersion": "1" },
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`QR status poll failed: ${res.status} ${text}`);
      }
      return JSON.parse(text) as QrCodeStatusResponse;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        return { status: "wait" };
      }
      throw err;
    }
  }
}
