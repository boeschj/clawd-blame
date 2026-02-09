import * as fs from "node:fs";
import * as path from "node:path";

import type * as vscode from "vscode";

import {
  findClaudeConfigDir,
  getProjectSessionsDir,
} from "../config/claude-paths.js";
import { addEditsToCommit } from "../config/commit-context-store.js";
import {
  isSessionProcessed,
  markSessionProcessed,
} from "../config/processing-state.js";
import { SESSION_FILE_EXTENSION } from "../constants.js";
import { findCommitForEdit } from "../git/commit-matcher.js";
import { readJsonlFile } from "../jsonl/reader.js";
import { parseSessionEdits } from "../jsonl/session-parser.js";
import type {
  ClaudeContextEdit,
  ParsedEdit,
  ProcessingResult,
  SessionResult,
} from "../types.js";

export async function processSessionsForProject(
  projectPath: string,
  context: vscode.ExtensionContext,
): Promise<ProcessingResult> {
  const result: ProcessingResult = {
    sessionsProcessed: 0,
    sessionsSkipped: 0,
    editsFound: 0,
    commitsLinked: 0,
    errors: [],
  };

  const claudeConfigDir = findClaudeConfigDir();
  if (!claudeConfigDir) {
    result.errors.push("Could not find Claude config directory");
    return result;
  }

  const sessionsDir = getProjectSessionsDir(claudeConfigDir, projectPath);
  if (!fs.existsSync(sessionsDir)) {
    result.errors.push(`Sessions directory not found: ${sessionsDir}`);
    return result;
  }

  const sessionFiles = findSessionFiles(sessionsDir);

  for (const sessionFile of sessionFiles) {
    try {
      const sessionResult = await processOneSession(
        sessionFile,
        projectPath,
        context,
      );

      if (!sessionResult) {
        result.sessionsSkipped++;
        continue;
      }

      result.sessionsProcessed++;
      result.editsFound += sessionResult.editsFound;
      result.commitsLinked += sessionResult.commitsLinked;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      result.errors.push(`Error processing ${sessionFile}: ${message}`);
    }
  }

  return result;
}

function findSessionFiles(sessionsDir: string): string[] {
  const allFiles = fs.readdirSync(sessionsDir, { withFileTypes: true });

  return allFiles
    .filter(
      (entry) =>
        entry.isFile() && entry.name.endsWith(SESSION_FILE_EXTENSION),
    )
    .map((entry) => path.join(sessionsDir, entry.name));
}

async function processOneSession(
  sessionFile: string,
  projectPath: string,
  context: vscode.ExtensionContext,
): Promise<SessionResult | null> {
  const stat = fs.statSync(sessionFile);
  const modTime = stat.mtimeMs;

  if (isSessionProcessed(context, sessionFile, modTime)) {
    return null;
  }

  const entries = await readJsonlFile(sessionFile);
  const edits = parseSessionEdits(entries);
  const editsByCommit = await groupEditsByCommit(projectPath, edits);

  let commitsLinked = 0;
  for (const [commitSha, commitEdits] of editsByCommit) {
    const edits = buildEditsForCommit(commitEdits);
    await addEditsToCommit(context, commitSha, edits);
    commitsLinked++;
  }

  await markSessionProcessed(context, sessionFile, modTime);

  return {
    editsFound: edits.length,
    commitsLinked,
  };
}

async function groupEditsByCommit(
  projectPath: string,
  edits: ParsedEdit[],
): Promise<Map<string, ParsedEdit[]>> {
  const editsByCommit = new Map<string, ParsedEdit[]>();

  for (const edit of edits) {
    const commitSha = await findCommitForEdit(projectPath, edit);
    if (!commitSha) {
      continue;
    }

    const existing = editsByCommit.get(commitSha);
    if (existing) {
      existing.push(edit);
    } else {
      editsByCommit.set(commitSha, [edit]);
    }
  }

  return editsByCommit;
}

function buildEditsForCommit(edits: ParsedEdit[]): ClaudeContextEdit[] {
  return edits.map((edit) => ({
    sessionId: edit.sessionId,
    filePath: edit.filePath,
    reasoning: edit.reasoning,
    intent: edit.intent,
    timestamp: edit.timestamp,
  }));
}
