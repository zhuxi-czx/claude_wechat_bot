import fs from "node:fs";
import path from "node:path";
import { log } from "../config.js";
import type { WeixinAccountData } from "../weixin/types.js";

export interface SessionData {
  sessionId: string;
  contextToken?: string;
  lastActiveAt: number;
}

export class StateStore {
  private dir: string;
  private token: string | undefined;
  private updatesBuf: string = "";
  private sessions: Map<string, SessionData> = new Map();
  private allowedUsers: Set<string> = new Set();
  private adminUser: string | undefined;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.load();
  }

  private load(): void {
    // Token
    const tokenPath = path.join(this.dir, "token.json");
    if (fs.existsSync(tokenPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
        this.token = data.token;
      } catch {
        log.warn("Failed to load token.json");
      }
    }

    // Sync buffer
    const statePath = path.join(this.dir, "state.json");
    if (fs.existsSync(statePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(statePath, "utf-8"));
        this.updatesBuf = data.get_updates_buf || "";
      } catch {
        log.warn("Failed to load state.json");
      }
    }

    // Sessions
    const sessionsPath = path.join(this.dir, "sessions.json");
    if (fs.existsSync(sessionsPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(sessionsPath, "utf-8"));
        for (const [key, value] of Object.entries(data)) {
          this.sessions.set(key, value as SessionData);
        }
      } catch {
        log.warn("Failed to load sessions.json");
      }
    }

    // Whitelist
    const whitelistPath = path.join(this.dir, "whitelist.json");
    if (fs.existsSync(whitelistPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(whitelistPath, "utf-8"));
        if (data.admin) this.adminUser = data.admin;
        if (Array.isArray(data.users)) {
          for (const u of data.users) this.allowedUsers.add(u);
        }
      } catch {
        log.warn("Failed to load whitelist.json");
      }
    }
  }

  getToken(): string | undefined {
    return this.token;
  }

  setToken(token: string): void {
    this.token = token;
    this.writeFileAtomic(path.join(this.dir, "token.json"), JSON.stringify({ token }, null, 2));
  }

  getUpdatesBuf(): string {
    return this.updatesBuf;
  }

  setUpdatesBuf(buf: string): void {
    this.updatesBuf = buf;
    this.markDirty();
  }

  getSession(userId: string): SessionData | undefined {
    return this.sessions.get(userId);
  }

  setSession(userId: string, data: SessionData): void {
    this.sessions.set(userId, data);
    this.markDirty();
  }

  getAllSessions(): Map<string, SessionData> {
    return new Map(this.sessions);
  }

  clearSession(userId: string): void {
    this.sessions.delete(userId);
    this.markDirty();
  }

  // ---- Whitelist ----

  getAdmin(): string | undefined {
    return this.adminUser;
  }

  setAdmin(userId: string): void {
    this.adminUser = userId;
    this.allowedUsers.add(userId);
    this.saveWhitelist();
  }

  isAllowed(userId: string): boolean {
    // No whitelist configured = allow everyone
    if (this.allowedUsers.size === 0 && !this.adminUser) return true;
    return this.allowedUsers.has(userId);
  }

  addAllowedUser(userId: string): void {
    this.allowedUsers.add(userId);
    this.saveWhitelist();
  }

  removeAllowedUser(userId: string): void {
    this.allowedUsers.delete(userId);
    this.saveWhitelist();
  }

  getAllowedUsers(): string[] {
    return [...this.allowedUsers];
  }

  isAdmin(userId: string): boolean {
    return this.adminUser === userId;
  }

  private saveWhitelist(): void {
    this.writeFileAtomic(
      path.join(this.dir, "whitelist.json"),
      JSON.stringify({
        admin: this.adminUser,
        users: [...this.allowedUsers],
      }, null, 2),
    );
  }

  private markDirty(): void {
    this.dirty = true;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flush();
        this.flushTimer = null;
      }, 1000);
    }
  }

  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;

    // State
    this.writeFileAtomic(
      path.join(this.dir, "state.json"),
      JSON.stringify({ get_updates_buf: this.updatesBuf }, null, 2),
    );

    // Sessions
    const sessionsObj: Record<string, SessionData> = {};
    for (const [key, value] of this.sessions) {
      sessionsObj[key] = value;
    }
    this.writeFileAtomic(
      path.join(this.dir, "sessions.json"),
      JSON.stringify(sessionsObj, null, 2),
    );
  }

  /**
   * Save WeChat account data (same structure as openclaw-weixin).
   * Writes to: {stateDir}/accounts/{accountId}.json
   * Updates index: {stateDir}/accounts.json
   */
  saveAccount(accountId: string, data: WeixinAccountData): void {
    const accountsDir = path.join(this.dir, "accounts");
    fs.mkdirSync(accountsDir, { recursive: true });

    // Write account file
    const accountPath = path.join(accountsDir, `${accountId}.json`);
    this.writeFileAtomic(accountPath, JSON.stringify(data, null, 2));
    try {
      fs.chmodSync(accountPath, 0o600);
    } catch {
      // best-effort
    }

    // Update accounts index
    const indexPath = path.join(this.dir, "accounts.json");
    let index: string[] = [];
    try {
      if (fs.existsSync(indexPath)) {
        index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
      }
    } catch {
      // ignore
    }
    if (!index.includes(accountId)) {
      index.push(accountId);
      this.writeFileAtomic(indexPath, JSON.stringify(index, null, 2));
    }

    log.info(`Account saved: ${accountId}`);
  }

  private writeFileAtomic(filePath: string, content: string): void {
    const tmpPath = filePath + ".tmp";
    try {
      fs.writeFileSync(tmpPath, content, "utf-8");
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      log.error(`Failed to write ${filePath}:`, err);
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
    }
  }
}
