import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { createInterface } from "node:readline";
import { log } from "../config.js";
import type { ClaudeConfig, ClaudeResult } from "./types.js";

export class ClaudeBridge {
  config: ClaudeConfig;
  private activeProcesses = new Map<string, ChildProcess>();

  constructor(config: ClaudeConfig) {
    this.config = config;
  }

  get activeCount(): number {
    return this.activeProcesses.size;
  }

  private buildStreamArgs(prompt: string, sessionId?: string, resume?: boolean): string[] {
    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];

    if (resume && sessionId) {
      args.push("--resume", sessionId);
    } else if (sessionId) {
      args.push("--session-id", sessionId);
    }

    args.push("--model", this.config.model);

    if (this.config.permissionMode) {
      args.push("--permission-mode", this.config.permissionMode);
    }

    if (this.config.maxBudget > 0) {
      args.push("--max-budget-usd", String(this.config.maxBudget));
    }

    if (this.config.systemPrompt) {
      args.push("--system-prompt", this.config.systemPrompt);
    }

    if (this.config.allowedTools) {
      args.push("--allowedTools", this.config.allowedTools);
    }

    // Grant access to additional directories (e.g., media download dir)
    if (this.config.addDirs && this.config.addDirs.length > 0) {
      args.push("--add-dir", ...this.config.addDirs);
    }

    return args;
  }

  /**
   * Stream query: yields partial text chunks as Claude generates them.
   * The final return value is the ClaudeResult.
   */
  async *queryStream(
    prompt: string,
    sessionId?: string,
    resume = false,
  ): AsyncGenerator<string, ClaudeResult> {
    if (this.activeProcesses.size >= this.config.maxConcurrent) {
      throw new Error(`Too many concurrent queries (max ${this.config.maxConcurrent}). Please wait.`);
    }

    const args = this.buildStreamArgs(prompt, sessionId, resume);
    const processKey = sessionId || crypto.randomUUID();

    log.debug(`Spawning stream: claude ${args.slice(0, 4).join(" ")}...`);

    const proc = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
      ...(this.config.workingDir ? { cwd: this.config.workingDir } : {}),
    });

    this.activeProcesses.set(processKey, proc);
    proc.stdin?.end();

    // Track process exit
    let processExited = false;
    let exitCode: number | null = null;
    let spawnError: Error | null = null;

    proc.on("close", (code) => {
      processExited = true;
      exitCode = code;
    });
    proc.on("error", (err) => {
      processExited = true;
      spawnError = err;
    });

    // Timeout handling
    let timedOut = false;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      // Force kill after 5 seconds if SIGTERM doesn't work
      setTimeout(() => {
        if (!processExited) proc.kill("SIGKILL");
      }, 5_000);
      log.warn(`Claude process timed out after ${this.config.timeoutMs}ms`);
    }, this.config.timeoutMs);

    const rl = createInterface({ input: proc.stdout! });
    let result: ClaudeResult | null = null;
    let accumulatedText = "";
    let lastYieldedLength = 0;

    try {
      for await (const line of rl) {
        try {
          const event = JSON.parse(line);

          if (event.type === "assistant" && event.message?.content) {
            // Extract text from content blocks — append, not overwrite
            for (const block of event.message.content) {
              if (block.type === "text" && block.text) {
                accumulatedText += block.text;
              }
            }
            // Yield new text since last yield
            if (accumulatedText.length > lastYieldedLength) {
              const newText = accumulatedText.slice(lastYieldedLength);
              lastYieldedLength = accumulatedText.length;
              yield newText;
            }
          } else if (event.type === "result") {
            result = event as ClaudeResult;
          }
        } catch {
          // non-JSON line, skip
        }
      }
    } finally {
      clearTimeout(timeoutTimer);
      this.activeProcesses.delete(processKey);
    }

    // Wait for process to fully exit (if not already)
    if (!processExited) {
      await new Promise<void>((resolve) => {
        proc.on("close", () => resolve());
        // Safety: resolve after 3s regardless
        setTimeout(resolve, 3_000);
      });
    }

    if (spawnError) {
      if ((spawnError as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("Claude Code CLI not found. Install: https://claude.com/claude-code");
      }
      throw spawnError;
    }

    if (timedOut) {
      throw new Error("Claude query timed out");
    }

    if (exitCode !== 0 && exitCode !== null && !result) {
      throw new Error(`Claude exited with code ${exitCode}`);
    }

    if (!result) {
      result = {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 0,
        result: accumulatedText,
        session_id: sessionId || "",
      };
    }

    log.debug(`Claude stream done: cost=$${result.total_cost_usd}, session=${result.session_id}`);
    return result;
  }

  /**
   * Simple one-shot query (non-streaming). Uses stream internally but collects full result.
   */
  async query(prompt: string, sessionId?: string, resume = false): Promise<ClaudeResult> {
    const gen = this.queryStream(prompt, sessionId, resume);
    let iter = await gen.next();
    while (!iter.done) {
      iter = await gen.next();
    }
    return iter.value;
  }

  abort(sessionId: string): boolean {
    const proc = this.activeProcesses.get(sessionId);
    if (proc) {
      proc.kill("SIGTERM");
      this.activeProcesses.delete(sessionId);
      return true;
    }
    return false;
  }

  abortAll(): void {
    for (const [key, proc] of this.activeProcesses) {
      proc.kill("SIGTERM");
      this.activeProcesses.delete(key);
    }
  }
}
