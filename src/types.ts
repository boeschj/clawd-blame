import type { ToolName, MessageRole } from "./constants.js";

export interface TextBlock {
  type: typeof import("./constants.js").CONTENT_BLOCK_TYPES.Text;
  text: string;
}

export interface ThinkingBlock {
  type: typeof import("./constants.js").CONTENT_BLOCK_TYPES.Thinking;
  thinking: string;
}

export interface ToolUseBlock {
  type: typeof import("./constants.js").CONTENT_BLOCK_TYPES.ToolUse;
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: typeof import("./constants.js").CONTENT_BLOCK_TYPES.ToolResult;
  tool_use_id: string;
  content: string | Record<string, unknown>[];
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock;

export interface ConversationMessage {
  role: MessageRole;
  content: ContentBlock[] | string;
}

export interface ConversationEntry {
  uuid: string;
  parentUuid?: string;
  sessionId: string;
  type: string;
  timestamp: string;
  message?: ConversationMessage;
  requestId?: string;
  isSidechain?: boolean;
}

export interface ParsedEdit {
  toolName: ToolName;
  filePath: string;
  oldString: string | null;
  newString: string;
  reasoning: string;
  intent: string;
  sessionId: string;
  timestamp: string;
}

export interface ClaudeContextEdit {
  sessionId: string;
  filePath: string;
  reasoning: string;
  intent: string;
  timestamp: string;
}

export interface CommitContext {
  edits: ClaudeContextEdit[];
}

export interface ProcessingResult {
  sessionsProcessed: number;
  sessionsSkipped: number;
  editsFound: number;
  commitsLinked: number;
  errors: string[];
}

export interface SessionResult {
  editsFound: number;
  commitsLinked: number;
}

export function isConversationEntry(
  value: unknown,
): value is ConversationEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record["uuid"] === "string" &&
    typeof record["sessionId"] === "string" &&
    typeof record["type"] === "string" &&
    typeof record["timestamp"] === "string"
  );
}

