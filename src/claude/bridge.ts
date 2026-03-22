import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { log } from "../config.js";
import type { ClaudeConfig, ClaudeResult } from "./types.js";

export class ClaudeBridge {
  private config: ClaudeConfig;
  private activeProcesses = new Map<string, ChildProcess>();

  constructor(config: ClaudeConfig) {
    this.config = config;
  }

  private buildArgs(prompt: string, sessionId?: string, resume?: boolean): string[] {
    const args = ["-p", prompt, "--output-format", "json"];

    if (resume && sessionId) {
      args.push("--resume", sessionId);
    } else if (sessionId) {
      args.push("--session-id", sessionId);
    }

    args.push("--model", this.config.model);
    args.push("--verbose");

    if (this.config.permissionMode) {
      args.push("--permission-mode", this.config.permissionMode);
    }

    if (this.config.maxBudget) {
      args.push("--max-budget-usd", String(this.config.maxBudget));
    }

    if (this.config.systemPrompt) {
      args.push("--system-prompt", this.config.systemPrompt);
    }

    if (this.config.allowedTools) {
      args.push("--allowedTools", this.config.allowedTools);
    }

    return args;
  }

  async query(prompt: string, sessionId?: string, resume = false): Promise<ClaudeResult> {
    const args = this.buildArgs(prompt, sessionId, resume);
    const processKey = sessionId || crypto.randomUUID();

    log.debug(`Spawning claude with args: ${args.join(" ")}`);

    return new Promise<ClaudeResult>((resolve, reject) => {
      const proc = spawn("claude", args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      this.activeProcesses.set(processKey, proc);

      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        this.activeProcesses.delete(processKey);

        if (code !== 0) {
          log.error(`Claude exited with code ${code}: ${stderr}`);
          reject(new Error(`Claude exited with code ${code}: ${stderr || "unknown error"}`));
          return;
        }

        try {
          // stdout may contain non-JSON lines (verbose output), find the JSON result
          const lines = stdout.trim().split("\n");
          let result: ClaudeResult | null = null;

          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const parsed = JSON.parse(lines[i]);
              if (parsed.type === "result") {
                result = parsed;
                break;
              }
            } catch {
              // not JSON, skip
            }
          }

          if (!result) {
            // Try parsing entire stdout as JSON
            result = JSON.parse(stdout) as ClaudeResult;
          }

          log.debug(`Claude response: cost=$${result.total_cost_usd}, session=${result.session_id}`);
          resolve(result);
        } catch (err) {
          log.error("Failed to parse Claude output:", stdout.slice(0, 500));
          reject(new Error(`Failed to parse Claude response: ${err}`));
        }
      });

      proc.on("error", (err) => {
        this.activeProcesses.delete(processKey);
        reject(err);
      });

      // Close stdin immediately since we're using -p
      proc.stdin?.end();
    });
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
