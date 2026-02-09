import type * as vscode from "vscode";

const WORKSPACE_STATE_KEY = "clawdBlame.processedSessions";

type ProcessedSessionsMap = Record<string, number>;

export function getProcessedSessions(
  context: vscode.ExtensionContext,
): ProcessedSessionsMap {
  return context.workspaceState.get<ProcessedSessionsMap>(
    WORKSPACE_STATE_KEY,
    {},
  );
}

export async function markSessionProcessed(
  context: vscode.ExtensionContext,
  sessionFile: string,
  modTime: number,
): Promise<void> {
  const sessions = getProcessedSessions(context);
  sessions[sessionFile] = modTime;
  await context.workspaceState.update(WORKSPACE_STATE_KEY, sessions);
}

export function isSessionProcessed(
  context: vscode.ExtensionContext,
  sessionFile: string,
  currentModTime: number,
): boolean {
  const sessions = getProcessedSessions(context);
  const processedModTime = sessions[sessionFile];
  return processedModTime !== undefined && processedModTime >= currentModTime;
}
