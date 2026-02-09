export const TOOL_NAMES = {
  Edit: "Edit",
  Write: "Write",
  MultiEdit: "MultiEdit",
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

export const ENTRY_TYPES = {
  User: "user",
  Assistant: "assistant",
  Summary: "summary",
} as const;

export const CONTENT_BLOCK_TYPES = {
  Text: "text",
  ToolUse: "tool_use",
  ToolResult: "tool_result",
  Thinking: "thinking",
} as const;

export const MESSAGE_ROLES = {
  User: "user",
  Assistant: "assistant",
} as const;

export type MessageRole = (typeof MESSAGE_ROLES)[keyof typeof MESSAGE_ROLES];

export const EXTENSION_COMMANDS = {
  ProcessSessions: "clawd-blame.processSessions",
} as const;

export const CONFIG_KEYS = {
  ClaudeConfigPath: "clawdBlame.claudeConfigPath",
} as const;

export const NULL_COMMIT_SHA = "0000000000000000000000000000000000000000";

export const MAX_REASONING_LENGTH = 500;
export const MAX_INTENT_LENGTH = 300;
export const MAX_PICKAXE_COMMITS = 200;
export const SHORT_SHA_LENGTH = 8;
export const MAX_DISPLAYED_ERRORS = 3;
export const SESSION_FILE_EXTENSION = ".jsonl";
