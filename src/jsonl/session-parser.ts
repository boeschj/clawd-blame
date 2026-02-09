import {
  CONTENT_BLOCK_TYPES,
  ENTRY_TYPES,
  MAX_INTENT_LENGTH,
  MAX_REASONING_LENGTH,
  TOOL_NAMES,
} from "../constants.js";
import type {
  ConversationEntry,
  ContentBlock,
  ParsedEdit,
  TextBlock,
  ToolUseBlock,
} from "../types.js";

const FILE_EDIT_TOOL_NAMES = new Set<string>([
  TOOL_NAMES.Edit,
  TOOL_NAMES.Write,
  TOOL_NAMES.MultiEdit,
]);

export function parseSessionEdits(
  entries: ConversationEntry[],
): ParsedEdit[] {
  const activeEntries = entries.filter(isActiveAssistantEntry);
  const entryLookup = buildEntryLookup(entries);
  const groupedByRequest = groupEntriesByRequestId(activeEntries);

  const parsedEdits: ParsedEdit[] = [];

  for (const group of groupedByRequest.values()) {
    const reasoning = extractReasoning(group);
    const toolUseBlocks = extractToolUseBlocks(group);
    const sessionId = group[0].sessionId;
    const timestamp = group[0].timestamp;
    const intent = findUserIntent(group[0], entryLookup);

    for (const toolUse of toolUseBlocks) {
      const edits = normalizeToolUseToEdits(toolUse, {
        reasoning,
        intent,
        sessionId,
        timestamp,
      });
      parsedEdits.push(...edits);
    }
  }

  return parsedEdits;
}

function isActiveAssistantEntry(entry: ConversationEntry): boolean {
  if (entry.isSidechain) {
    return false;
  }
  if (!entry.message) {
    return false;
  }
  return entry.type === ENTRY_TYPES.Assistant;
}

function buildEntryLookup(
  entries: ConversationEntry[],
): Map<string, ConversationEntry> {
  const lookup = new Map<string, ConversationEntry>();
  for (const entry of entries) {
    lookup.set(entry.uuid, entry);
  }
  return lookup;
}

function groupEntriesByRequestId(
  entries: ConversationEntry[],
): Map<string, ConversationEntry[]> {
  const groups = new Map<string, ConversationEntry[]>();

  for (const entry of entries) {
    const key = entry.requestId ?? entry.uuid;
    const existing = groups.get(key);
    if (existing) {
      existing.push(entry);
    } else {
      groups.set(key, [entry]);
    }
  }

  return groups;
}

function getContentBlocks(entry: ConversationEntry): ContentBlock[] {
  const message = entry.message;
  if (!message) {
    return [];
  }

  if (typeof message.content === "string") {
    return [{ type: CONTENT_BLOCK_TYPES.Text, text: message.content }];
  }

  return message.content;
}

function extractReasoning(group: ConversationEntry[]): string {
  const textParts: string[] = [];

  for (const entry of group) {
    const blocks = getContentBlocks(entry);
    for (const block of blocks) {
      if (isTextBlock(block) && block.text.trim().length > 0) {
        textParts.push(block.text.trim());
      }
    }
  }

  const combined = textParts.join(" ");
  return truncate(combined, MAX_REASONING_LENGTH);
}

function extractToolUseBlocks(group: ConversationEntry[]): ToolUseBlock[] {
  const toolUseBlocks: ToolUseBlock[] = [];

  for (const entry of group) {
    const blocks = getContentBlocks(entry);
    for (const block of blocks) {
      if (isToolUseBlock(block) && FILE_EDIT_TOOL_NAMES.has(block.name)) {
        toolUseBlocks.push(block);
      }
    }
  }

  return toolUseBlocks;
}

function findUserIntent(
  assistantEntry: ConversationEntry,
  entryLookup: Map<string, ConversationEntry>,
): string {
  let current: ConversationEntry | undefined = assistantEntry;

  while (current?.parentUuid) {
    const parent = entryLookup.get(current.parentUuid);
    if (!parent) {
      break;
    }

    if (parent.type === ENTRY_TYPES.User && parent.message) {
      const userText = extractTextFromMessage(parent);
      return truncate(userText, MAX_INTENT_LENGTH);
    }

    current = parent;
  }

  return "";
}

function extractTextFromMessage(entry: ConversationEntry): string {
  const message = entry.message;
  if (!message) {
    return "";
  }

  if (typeof message.content === "string") {
    return message.content;
  }

  const textParts: string[] = [];
  for (const block of message.content) {
    if (isTextBlock(block)) {
      textParts.push(block.text);
    }
  }
  return textParts.join(" ");
}

interface EditContext {
  reasoning: string;
  intent: string;
  sessionId: string;
  timestamp: string;
}

function normalizeToolUseToEdits(
  toolUse: ToolUseBlock,
  context: EditContext,
): ParsedEdit[] {
  const baseEdit = {
    reasoning: context.reasoning,
    intent: context.intent,
    sessionId: context.sessionId,
    timestamp: context.timestamp,
  };

  if (toolUse.name === TOOL_NAMES.Write) {
    const filePath = String(toolUse.input["file_path"] ?? "");
    const content = String(toolUse.input["content"] ?? "");
    return [
      {
        ...baseEdit,
        toolName: TOOL_NAMES.Write,
        filePath,
        oldString: null,
        newString: content,
      },
    ];
  }

  if (toolUse.name === TOOL_NAMES.Edit) {
    const filePath = String(toolUse.input["file_path"] ?? "");
    const oldString = String(toolUse.input["old_string"] ?? "");
    const newString = String(toolUse.input["new_string"] ?? "");
    return [
      {
        ...baseEdit,
        toolName: TOOL_NAMES.Edit,
        filePath,
        oldString,
        newString,
      },
    ];
  }

  if (toolUse.name === TOOL_NAMES.MultiEdit) {
    const filePath = String(toolUse.input["file_path"] ?? "");
    const edits = toolUse.input["edits"];
    if (!Array.isArray(edits)) {
      return [];
    }

    return edits.map((edit: Record<string, unknown>) => ({
      ...baseEdit,
      toolName: TOOL_NAMES.MultiEdit,
      filePath,
      oldString: String(edit["old_string"] ?? ""),
      newString: String(edit["new_string"] ?? ""),
    }));
  }

  return [];
}

function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === CONTENT_BLOCK_TYPES.Text;
}

function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return block.type === CONTENT_BLOCK_TYPES.ToolUse;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength) + "...";
}
