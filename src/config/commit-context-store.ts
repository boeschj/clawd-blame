import type * as vscode from "vscode";

import type { ClaudeContextEdit, CommitContext } from "../types.js";

type CommitContextMap = Record<string, CommitContext>;

const WORKSPACE_STATE_KEY = "clawdBlame.commitContext";

function getCommitContextMap(
  context: vscode.ExtensionContext,
): CommitContextMap {
  return context.workspaceState.get<CommitContextMap>(WORKSPACE_STATE_KEY, {});
}

export function getCommitContext(
  context: vscode.ExtensionContext,
  commitSha: string,
): CommitContext | null {
  const map = getCommitContextMap(context);
  return map[commitSha] ?? null;
}

export async function addEditsToCommit(
  context: vscode.ExtensionContext,
  commitSha: string,
  edits: ClaudeContextEdit[],
): Promise<void> {
  const map = getCommitContextMap(context);
  const existing = map[commitSha];

  const mergedEdits = existing ? [...existing.edits, ...edits] : edits;

  map[commitSha] = { edits: mergedEdits };
  await context.workspaceState.update(WORKSPACE_STATE_KEY, map);
}
