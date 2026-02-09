import * as vscode from "vscode";

import { processSessionsForProject } from "./commands/process-sessions.js";
import { EXTENSION_COMMANDS, MAX_DISPLAYED_ERRORS } from "./constants.js";
import { ClaudeContextHoverProvider } from "./providers/hover-provider.js";

export function activate(context: vscode.ExtensionContext) {
  const hoverProvider = vscode.languages.registerHoverProvider(
    { scheme: "file" },
    new ClaudeContextHoverProvider(context),
  );

  const processCommand = vscode.commands.registerCommand(
    EXTENSION_COMMANDS.ProcessSessions,
    () => runProcessSessions(context),
  );

  context.subscriptions.push(hoverProvider, processCommand);
}

async function runProcessSessions(
  context: vscode.ExtensionContext,
): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage(
      "Clawd Blame: No workspace folder is open.",
    );
    return;
  }

  const projectPath = workspaceFolder.uri.fsPath;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Clawd Blame: Processing sessions...",
      cancellable: false,
    },
    async () => {
      const result = await processSessionsForProject(projectPath, context);

      if (result.errors.length > 0) {
        const errorSummary = result.errors
          .slice(0, MAX_DISPLAYED_ERRORS)
          .join("; ");
        vscode.window.showWarningMessage(
          `Clawd Blame: Processed ${result.sessionsProcessed} sessions with ${result.errors.length} errors. ${errorSummary}`,
        );
        return;
      }

      vscode.window.showInformationMessage(
        `Clawd Blame: Processed ${result.sessionsProcessed} sessions. Found ${result.editsFound} edits, linked ${result.commitsLinked} commits.`,
      );
    },
  );
}

export function deactivate() {}
