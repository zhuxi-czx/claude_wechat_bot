import crypto from "node:crypto";
import type { StateStore, SessionData } from "../state/store.js";

export class SessionManager {
  private store: StateStore;
  private contextTokens = new Map<string, string>();

  constructor(store: StateStore) {
    this.store = store;
    // Load context tokens from persisted sessions
    this.loadContextTokens();
  }

  private loadContextTokens(): void {
    const sessions = this.store.getAllSessions();
    for (const [userId, data] of sessions) {
      if (data.contextToken) {
        this.contextTokens.set(userId, data.contextToken);
      }
    }
  }

  getSessionId(userId: string): string | undefined {
    return this.store.getSession(userId)?.sessionId;
  }

  hasSession(userId: string): boolean {
    return !!this.store.getSession(userId);
  }

  setSessionId(userId: string, sessionId: string): void {
    const existing = this.store.getSession(userId);
    this.store.setSession(userId, {
      sessionId,
      contextToken: existing?.contextToken,
      lastActiveAt: Date.now(),
    });
  }

  getOrCreateSessionId(userId: string): string {
    const existing = this.getSessionId(userId);
    if (existing) return existing;
    const newId = crypto.randomUUID();
    this.setSessionId(userId, newId);
    return newId;
  }

  clearSession(userId: string): void {
    this.store.clearSession(userId);
    this.contextTokens.delete(userId);
  }

  setContextToken(userId: string, token: string): void {
    this.contextTokens.set(userId, token);
    const session = this.store.getSession(userId);
    if (session) {
      session.contextToken = token;
      this.store.setSession(userId, session);
    }
  }

  getContextToken(userId: string): string | undefined {
    return this.contextTokens.get(userId);
  }
}
