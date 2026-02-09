import * as path from "node:path";

import * as vscode from "vscode";

import { getCommitContext } from "../config/commit-context-store.js";
import { SHORT_SHA_LENGTH } from "../constants.js";
import { getBlameForLine } from "../git/blame.js";
import type { CommitContext } from "../types.js";

export class ClaudeContextHoverProvider implements vscode.HoverProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Hover | null> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
      return null;
    }

    const repoPath = workspaceFolder.uri.fsPath;
    const relativePath = path.relative(repoPath, document.uri.fsPath);
    const lineNumber = position.line + 1;

    const commitSha = await getBlameForLine(repoPath, relativePath, lineNumber);
    if (!commitSha) {
      return null;
    }

    const commitContext = getCommitContext(this.context, commitSha);
    if (!commitContext) {
      return null;
    }

    const relevantEdit = findRelevantEdit(commitContext, relativePath);
    if (!relevantEdit) {
      return null;
    }

    const markdown = buildHoverMarkdown(
      relevantEdit.intent,
      relevantEdit.reasoning,
      relevantEdit.sessionId,
      commitSha,
    );

    return new vscode.Hover(markdown);
  }
}

function findRelevantEdit(
  commitContext: CommitContext,
  relativePath: string,
): { sessionId: string; intent: string; reasoning: string } | null {
  for (const edit of commitContext.edits) {
    const normalizedEditPath = edit.filePath.startsWith("/")
      ? edit.filePath.slice(1)
      : edit.filePath;

    const pathsMatch =
      normalizedEditPath === relativePath ||
      normalizedEditPath.endsWith(`/${relativePath}`);

    if (pathsMatch) {
      return {
        sessionId: edit.sessionId,
        intent: edit.intent,
        reasoning: edit.reasoning,
      };
    }
  }

  return null;
}

function buildHoverMarkdown(
  intent: string,
  reasoning: string,
  sessionId: string,
  commitSha: string,
): vscode.MarkdownString {
  const md = new vscode.MarkdownString();

  md.appendMarkdown("### Claude Context\n\n");

  if (intent) {
    md.appendMarkdown(`**You asked:** ${escapeMarkdown(intent)}\n\n`);
  }

  if (reasoning) {
    md.appendMarkdown(
      `**Claude's reasoning:** ${escapeMarkdown(reasoning)}\n\n`,
    );
  }

  const shortSha = commitSha.slice(0, SHORT_SHA_LENGTH);
  md.appendMarkdown("---\n\n");
  md.appendMarkdown(
    `*Session:* \`${escapeMarkdown(sessionId)}\` · *Commit:* \`${shortSha}\``,
  );

  return md;
}

function escapeMarkdown(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/[*_`[\]()#>+\-!|{}]/g, "\\$&");
}
