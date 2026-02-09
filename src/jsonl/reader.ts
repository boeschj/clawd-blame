import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import { isConversationEntry } from "../types.js";

import type { ConversationEntry } from "../types.js";

export async function readJsonlFile(
  filePath: string,
): Promise<ConversationEntry[]> {
  const entries: ConversationEntry[] = [];

  const lineReader = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  for await (const line of lineReader) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isConversationEntry(parsed)) {
        entries.push(parsed);
      }
    } catch {
      continue;
    }
  }

  return entries;
}
