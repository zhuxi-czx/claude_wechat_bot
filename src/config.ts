import "dotenv/config";

export interface Config {
  wechat: {
    baseUrl: string;
    maxMsgLength: number;
  };
  claude: {
    model: string;
    systemPrompt?: string;
    maxBudget: number;
    permissionMode: string;
    allowedTools?: string;
  };
  stateDir: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

export function loadConfig(): Config {
  return {
    wechat: {
      baseUrl: process.env.WECHAT_BASE_URL || "https://ilinkai.weixin.qq.com",
      maxMsgLength: parseInt(process.env.WECHAT_MAX_MSG_LENGTH || "4000", 10),
    },
    claude: {
      model: process.env.CLAUDE_MODEL || "sonnet",
      systemPrompt: process.env.CLAUDE_SYSTEM_PROMPT || undefined,
      maxBudget: parseFloat(process.env.CLAUDE_MAX_BUDGET || "1.0"),
      permissionMode: process.env.CLAUDE_PERMISSION_MODE || "default",
      allowedTools: process.env.CLAUDE_ALLOWED_TOOLS || undefined,
    },
    stateDir: process.env.STATE_DIR || "./data",
    logLevel: (process.env.LOG_LEVEL as Config["logLevel"]) || "info",
  };
}

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;

let currentLevel: number = LOG_LEVELS.info;

export function setLogLevel(level: Config["logLevel"]): void {
  currentLevel = LOG_LEVELS[level];
}

export const log = {
  debug: (...args: unknown[]) => {
    if (currentLevel <= 0) console.log("[DEBUG]", new Date().toISOString(), ...args);
  },
  info: (...args: unknown[]) => {
    if (currentLevel <= 1) console.log("[INFO]", new Date().toISOString(), ...args);
  },
  warn: (...args: unknown[]) => {
    if (currentLevel <= 2) console.warn("[WARN]", new Date().toISOString(), ...args);
  },
  error: (...args: unknown[]) => {
    if (currentLevel <= 3) console.error("[ERROR]", new Date().toISOString(), ...args);
  },
};
