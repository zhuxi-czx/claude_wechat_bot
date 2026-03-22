import { EventEmitter } from "node:events";
import { log } from "../config.js";
import type { WeixinClient } from "./client.js";
import type { WeixinMessage } from "./types.js";
import type { StateStore } from "../state/store.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class WeixinPoller extends EventEmitter {
  private client: WeixinClient;
  private store: StateStore;
  private running = false;
  private consecutiveErrors = 0;
  private seenIds = new Set<string>();
  private readonly MAX_SEEN = 1000;

  constructor(client: WeixinClient, store: StateStore) {
    super();
    this.client = client;
    this.store = store;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    log.info("WeChat poller started");
    this.poll();
  }

  async stop(): Promise<void> {
    this.running = false;
    log.info("WeChat poller stopped");
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const buf = this.store.getUpdatesBuf();
        const resp = await this.client.getUpdates(buf);

        // Check for API errors: ret must be explicitly non-zero (undefined/0 = OK)
        const isError =
          (resp.ret !== undefined && resp.ret !== 0) ||
          (resp.errcode !== undefined && resp.errcode !== 0);

        if (isError) {
          const isSessionExpired = resp.errcode === -14 || resp.ret === -14;

          if (isSessionExpired) {
            // Session timeout — common after fresh login or idle period.
            // Pause 30s then retry, don't exit.
            log.warn("Session timeout (errcode -14), retrying in 30s...");
            await sleep(30_000);
            // Reset sync buf — server may need a fresh start
            this.store.setUpdatesBuf("");
            this.consecutiveErrors = 0;
            continue;
          }

          this.consecutiveErrors++;
          log.warn(
            `getUpdates error: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg} (${this.consecutiveErrors}/3)`,
          );

          if (this.consecutiveErrors >= 3) {
            log.warn("Too many consecutive errors, backing off 30s");
            this.consecutiveErrors = 0;
            await sleep(30_000);
          } else {
            await sleep(3_000);
          }
          continue;
        }

        this.consecutiveErrors = 0;

        if (resp.get_updates_buf) {
          this.store.setUpdatesBuf(resp.get_updates_buf);
        }

        if (resp.msgs && resp.msgs.length > 0) {
          for (const msg of resp.msgs) {
            // Only process user messages
            if (msg.message_type !== 1) continue;

            // Deduplicate
            const dedupKey = msg.client_id || `${msg.from_user_id}:${msg.create_time_ms}`;
            if (this.seenIds.has(dedupKey)) continue;

            this.seenIds.add(dedupKey);
            if (this.seenIds.size > this.MAX_SEEN) {
              const first = this.seenIds.values().next().value;
              if (first) this.seenIds.delete(first);
            }

            this.emit("message", msg);
          }
        }
      } catch (err) {
        this.consecutiveErrors++;
        log.error("Poll error:", err);
        this.emit("error", err instanceof Error ? err : new Error(String(err)));

        if (this.consecutiveErrors >= 3) {
          this.consecutiveErrors = 0;
          await sleep(30_000);
        } else {
          await sleep(3_000);
        }
      }
    }
  }
}
