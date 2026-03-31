export interface ClaudeResult {
  type: "result";
  subtype: string;
  is_error: boolean;
  duration_ms: number;
  result: string;
  session_id: string;
  total_cost_usd?: number;
  stop_reason?: string;
}

export interface ClaudeConfig {
  model: string;
  systemPrompt?: string;
  maxBudget: number;
  permissionMode: string;
  allowedTools?: string;
  timeoutMs: number;
  maxConcurrent: number;
  addDirs?: string[];
  workingDir?: string;
}
