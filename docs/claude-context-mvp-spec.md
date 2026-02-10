# Claude Context: MVP Specification

## Project Overview

Build a VS Code extension that answers "why was this line of code written?" by linking Claude Code conversation history to specific git commits. When a developer hovers over a line of code, they see the original intent and reasoning from the AI session that produced it.

**Target Users:** Developers using Claude Code who need to understand/maintain AI-generated code.

**Core Insight:** Git already tracks *what* changed and *when*. Claude Code's JSONL logs contain *why*. We link them via exact string matching.

---

## The Problem

When developers use Claude Code for "vibe coding," they generate code faster than they can understand it. Later, when maintaining or refactoring:

- "I have no understanding how any of it works" (HN comment)
- "Neither one of us has any clue why certain decisions were made" (real user pain)
- Context is scattered across JSONL files that no one reads

**The solution:** Surface Claude's reasoning at the exact moment you need it—when you're reading the code.

---

## Technical Architecture

### Data Flow

```
~/.claude/projects/[encoded-path]/*.jsonl (Claude Code stores this)
                    │
                    ▼
         [Processing Pipeline]
                    │
                    ▼
    Git Notes (refs/notes/claude-context)
                    │
                    ▼
         VS Code Extension
                    │
                    ▼
    Hover: line → git blame → note lookup → display
```

### Why Git Notes?

- **100% accurate:** No fuzzy matching, exact commit-level provenance
- **Travels with repo:** Push notes, team sees them (`git push origin refs/notes/*`)
- **Survives history:** Deleted files still have commits with notes attached
- **Git handles hard problems:** Renames via `--follow`, line tracking via `blame`

---

## Claude Code Data Structure

### Location

```
~/.claude/projects/[encoded-path]/[session-uuid].jsonl
~/.claude/history.jsonl (index of all sessions)
```

The `[encoded-path]` is the project directory with `/` replaced by `-`, e.g.:
`-Users-jordan-projects-myapp` for `/Users/jordan/projects/myapp`

### JSONL Entry Schema

Each line is a JSON object:

```typescript
interface ConversationEntry {
  uuid: string;
  parentUuid: string;           // Threading - links to parent message
  sessionId: string;
  cwd: string;                  // Working directory
  gitBranch: string;            // Git branch at time of message
  version: string;              // Claude Code version
  timestamp: string;            // ISO-8601
  type: "user" | "assistant" | "summary";
  
  message: {
    role: "user" | "assistant";
    content: ContentBlock[];    // Array of content blocks
  };
  
  toolUseResult?: {             // Present on user turns after tool_use
    stdout: string;
    stderr: string;
    interrupted: boolean;
  };
}

type ContentBlock = 
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: ToolInput }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
```

### Tool Input Schemas (File Operations)

**Edit** - The primary source of code changes:
```typescript
interface EditInput {
  file_path: string;      // Absolute path
  old_string: string;     // Exact text to find
  new_string: string;     // Exact replacement text
}
```

**Write** - New file creation:
```typescript
interface WriteInput {
  file_path: string;
  content: string;        // Full file content
}
```

**MultiEdit** - Batch edits:
```typescript
interface MultiEditInput {
  file_path: string;
  edits: Array<{ old_string: string; new_string: string }>;
}
```

### Key Insight: Exact Strings

Claude's `Edit.old_string` and `Edit.new_string` are **exact**. When Claude writes:
```json
{
  "type": "tool_use",
  "name": "Edit",
  "input": {
    "file_path": "/path/to/file.ts",
    "old_string": "const t = trips[0];",
    "new_string": "const trip = trips[0];"
  }
}
```

This means it literally replaced that exact string. If a git commit shows:
```diff
-const t = trips[0];
+const trip = trips[0];
```

These are the same edit. **String equality, not fuzzy matching.**

---

## The Matching Algorithm

### Step 1: Parse Claude Session

```typescript
interface ParsedEdit {
  sessionId: string;
  timestamp: string;
  filePath: string;
  oldString: string;
  newString: string;
  reasoning: string;      // Adjacent text blocks from Claude
  intent: string;         // User's message that triggered this (or session start)
}

function parseSession(jsonlPath: string): ParsedEdit[] {
  const entries = readJsonlFile(jsonlPath);
  const edits: ParsedEdit[] = [];
  
  // Build parent chain for context lookup
  const entriesByUuid = new Map(entries.map(e => [e.uuid, e]));
  
  for (const entry of entries) {
    if (entry.type !== 'assistant') continue;
    
    const toolUses = entry.message.content.filter(c => c.type === 'tool_use');
    const textBlocks = entry.message.content.filter(c => c.type === 'text');
    const reasoning = textBlocks.map(t => t.text).join('\n');
    
    for (const tool of toolUses) {
      if (tool.name === 'Edit' || tool.name === 'MultiEdit' || tool.name === 'Write') {
        const editList = tool.name === 'MultiEdit' 
          ? tool.input.edits.map(e => ({ ...e, file_path: tool.input.file_path }))
          : tool.name === 'Write'
          ? [{ file_path: tool.input.file_path, old_string: null, new_string: tool.input.content }]
          : [tool.input];
        
        for (const edit of editList) {
          edits.push({
            sessionId: entry.sessionId,
            timestamp: entry.timestamp,
            filePath: edit.file_path,
            oldString: edit.old_string,
            newString: edit.new_string,
            reasoning: reasoning,
            intent: findIntent(entry, entriesByUuid)
          });
        }
      }
    }
  }
  
  return edits;
}

function findIntent(entry: ConversationEntry, entriesByUuid: Map): string {
  // Walk up parentUuid chain to find the user message that triggered this
  let current = entry;
  while (current.parentUuid && entriesByUuid.has(current.parentUuid)) {
    const parent = entriesByUuid.get(current.parentUuid);
    if (parent.type === 'user') {
      const textContent = parent.message.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n');
      if (textContent.trim()) return textContent;
    }
    current = parent;
  }
  return '';
}
```

### Step 2: Find Matching Git Commits

```typescript
import { execSync } from 'child_process';

interface CommitMatch {
  commitSha: string;
  edit: ParsedEdit;
}

function findCommitForEdit(edit: ParsedEdit, repoPath: string): string | null {
  // For Write (new file), search for commits that added the file
  if (edit.oldString === null) {
    const cmd = `git log --diff-filter=A --format="%H" -- "${edit.filePath}"`;
    const result = execSync(cmd, { cwd: repoPath }).toString().trim();
    return result.split('\n')[0] || null;
  }
  
  // For Edit, use git pickaxe to find commits with these exact strings
  // The -S flag finds commits that changed the number of occurrences of a string
  try {
    // Find commits that have both the old and new string in their diff
    const cmd = `git log -S "${escapeForShell(edit.oldString)}" --format="%H" -- "${edit.filePath}"`;
    const commits = execSync(cmd, { cwd: repoPath }).toString().trim().split('\n').filter(Boolean);
    
    for (const commitSha of commits) {
      if (verifyExactMatch(commitSha, edit, repoPath)) {
        return commitSha;
      }
    }
  } catch (e) {
    // git log -S can fail on special characters
    return null;
  }
  
  return null;
}

function verifyExactMatch(commitSha: string, edit: ParsedEdit, repoPath: string): boolean {
  // Get the diff for this specific file in this commit
  const cmd = `git show --format= "${commitSha}" -- "${edit.filePath}"`;
  const diff = execSync(cmd, { cwd: repoPath }).toString();
  
  // Check if diff contains our exact old_string (removed) and new_string (added)
  const removedLines = diff.split('\n')
    .filter(line => line.startsWith('-') && !line.startsWith('---'))
    .map(line => line.substring(1));
  
  const addedLines = diff.split('\n')
    .filter(line => line.startsWith('+') && !line.startsWith('+++'))
    .map(line => line.substring(1));
  
  const removedContent = removedLines.join('\n');
  const addedContent = addedLines.join('\n');
  
  // Check for exact substring match
  return removedContent.includes(edit.oldString) && addedContent.includes(edit.newString);
}
```

### Step 3: Attach Git Notes

```typescript
interface ClaudeContextNote {
  sessionId: string;
  timestamp: string;
  intent: string;
  edits: Array<{
    filePath: string;
    reasoning: string;
  }>;
}

function attachNote(commitSha: string, context: ClaudeContextNote, repoPath: string): void {
  const noteContent = JSON.stringify(context, null, 2);
  
  // Check if note already exists
  try {
    const existing = execSync(
      `git notes --ref=claude-context show ${commitSha}`,
      { cwd: repoPath }
    ).toString();
    
    // Merge with existing note
    const existingContext = JSON.parse(existing);
    existingContext.edits = [...existingContext.edits, ...context.edits];
    const merged = JSON.stringify(existingContext, null, 2);
    
    execSync(
      `git notes --ref=claude-context add -f -m '${escapeForShell(merged)}' ${commitSha}`,
      { cwd: repoPath }
    );
  } catch {
    // No existing note, create new one
    execSync(
      `git notes --ref=claude-context add -m '${escapeForShell(noteContent)}' ${commitSha}`,
      { cwd: repoPath }
    );
  }
}
```

---

## VS Code Extension

### Extension Structure

```
claude-context/
├── package.json
├── tsconfig.json
├── src/
│   ├── extension.ts          # Entry point, activation
│   ├── parser/
│   │   └── jsonlParser.ts    # Parse Claude Code JSONL files
│   ├── git/
│   │   ├── blame.ts          # Git blame operations
│   │   ├── notes.ts          # Git notes read/write
│   │   └── matcher.ts        # Match edits to commits
│   ├── providers/
│   │   ├── hoverProvider.ts  # Show context on hover
│   │   └── decorationProvider.ts  # Gutter icons
│   ├── commands/
│   │   ├── processSession.ts # Process JSONL → git notes
│   │   └── viewSession.ts    # Open full session view
│   └── utils/
│       ├── config.ts         # Find Claude config location
│       └── shell.ts          # Shell escape utilities
└── test/
```

### package.json

```json
{
  "name": "claude-context",
  "displayName": "Claude Context",
  "description": "See why Claude wrote this code",
  "version": "0.1.0",
  "engines": {
    "vscode": "^1.74.0"
  },
  "categories": ["Other"],
  "activationEvents": [
    "onLanguage:typescript",
    "onLanguage:javascript",
    "onLanguage:python",
    "onLanguage:rust",
    "onLanguage:go"
  ],
  "main": "./out/extension.js",
  "contributes": {
    "commands": [
      {
        "command": "claudeContext.processCurrentProject",
        "title": "Claude Context: Process Sessions for Current Project"
      },
      {
        "command": "claudeContext.viewSessionForLine",
        "title": "Claude Context: View Full Session"
      }
    ],
    "configuration": {
      "title": "Claude Context",
      "properties": {
        "claudeContext.claudeConfigPath": {
          "type": "string",
          "default": "",
          "description": "Custom path to Claude Code config directory (defaults to ~/.claude)"
        },
        "claudeContext.autoProcess": {
          "type": "boolean",
          "default": false,
          "description": "Automatically process new sessions on startup"
        }
      }
    }
  },
  "scripts": {
    "vscode:prepublish": "npm run compile",
    "compile": "tsc -p ./",
    "watch": "tsc -watch -p ./"
  },
  "devDependencies": {
    "@types/vscode": "^1.74.0",
    "@types/node": "^18.0.0",
    "typescript": "^5.0.0"
  }
}
```

### Hover Provider

```typescript
// src/providers/hoverProvider.ts
import * as vscode from 'vscode';
import { getBlameForLine } from '../git/blame';
import { getNoteForCommit } from '../git/notes';

export class ClaudeContextHoverProvider implements vscode.HoverProvider {
  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Hover | null> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) return null;
    
    const repoPath = workspaceFolder.uri.fsPath;
    const filePath = document.uri.fsPath;
    const lineNumber = position.line + 1; // git blame is 1-indexed
    
    // Step 1: Get commit for this line
    const commitSha = await getBlameForLine(repoPath, filePath, lineNumber);
    if (!commitSha) return null;
    
    // Step 2: Check for Claude context note
    const note = await getNoteForCommit(repoPath, commitSha);
    if (!note) return null;
    
    // Step 3: Find relevant edit for this file
    const relevantEdit = note.edits.find(e => 
      filePath.endsWith(e.filePath) || e.filePath.endsWith(filePath.split('/').pop()!)
    );
    
    // Step 4: Build hover content
    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = true;
    
    markdown.appendMarkdown(`### 🤖 Claude Context\n\n`);
    markdown.appendMarkdown(`**Commit:** \`${commitSha.substring(0, 7)}\`\n\n`);
    markdown.appendMarkdown(`**Session:** ${note.sessionId.substring(0, 8)}...\n\n`);
    
    if (note.intent) {
      markdown.appendMarkdown(`**You asked:**\n> ${truncate(note.intent, 200)}\n\n`);
    }
    
    if (relevantEdit?.reasoning) {
      markdown.appendMarkdown(`**Claude's reasoning:**\n> ${truncate(relevantEdit.reasoning, 300)}\n\n`);
    }
    
    markdown.appendMarkdown(`[View Full Session](command:claudeContext.viewSessionForLine?${encodeURIComponent(JSON.stringify({ sessionId: note.sessionId }))})`);
    
    return new vscode.Hover(markdown);
  }
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}
```

### Git Blame

```typescript
// src/git/blame.ts
import { execSync } from 'child_process';

export async function getBlameForLine(
  repoPath: string,
  filePath: string,
  lineNumber: number
): Promise<string | null> {
  try {
    const relativePath = filePath.replace(repoPath + '/', '');
    const cmd = `git blame -L ${lineNumber},${lineNumber} --porcelain "${relativePath}"`;
    const output = execSync(cmd, { cwd: repoPath }).toString();
    
    // First line of porcelain output is: <sha> <original-line> <final-line> <num-lines>
    const sha = output.split(' ')[0];
    
    // Check if it's the null commit (uncommitted changes)
    if (sha === '0000000000000000000000000000000000000000') {
      return null;
    }
    
    return sha;
  } catch (e) {
    return null;
  }
}
```

### Git Notes

```typescript
// src/git/notes.ts
import { execSync } from 'child_process';

export interface ClaudeContextNote {
  sessionId: string;
  timestamp: string;
  intent: string;
  edits: Array<{
    filePath: string;
    reasoning: string;
  }>;
}

export async function getNoteForCommit(
  repoPath: string,
  commitSha: string
): Promise<ClaudeContextNote | null> {
  try {
    const cmd = `git notes --ref=claude-context show ${commitSha}`;
    const output = execSync(cmd, { cwd: repoPath }).toString();
    return JSON.parse(output);
  } catch {
    return null;
  }
}

export async function setNoteForCommit(
  repoPath: string,
  commitSha: string,
  note: ClaudeContextNote
): Promise<void> {
  const noteJson = JSON.stringify(note, null, 2);
  const escaped = noteJson.replace(/'/g, "'\\''");
  
  try {
    // Try to add (will fail if exists)
    execSync(
      `git notes --ref=claude-context add -m '${escaped}' ${commitSha}`,
      { cwd: repoPath }
    );
  } catch {
    // Note exists, force overwrite (or merge - see full implementation)
    execSync(
      `git notes --ref=claude-context add -f -m '${escaped}' ${commitSha}`,
      { cwd: repoPath }
    );
  }
}
```

### Config Discovery

```typescript
// src/utils/config.ts
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

export function findClaudeConfigPath(): string | null {
  // 1. Check VS Code setting
  const configuredPath = vscode.workspace
    .getConfiguration('claudeContext')
    .get<string>('claudeConfigPath');
  
  if (configuredPath && fs.existsSync(configuredPath)) {
    return configuredPath;
  }
  
  // 2. Check environment variable
  const envPath = process.env.CLAUDE_CONFIG_DIR;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }
  
  // 3. Standard location
  const standardPath = path.join(os.homedir(), '.claude');
  if (fs.existsSync(standardPath)) {
    return standardPath;
  }
  
  return null;
}

export function getProjectSessionsPath(claudeConfigPath: string, projectPath: string): string {
  // Claude encodes paths by replacing / with -
  const encoded = projectPath.replace(/\//g, '-');
  return path.join(claudeConfigPath, 'projects', encoded);
}
```

### Extension Entry Point

```typescript
// src/extension.ts
import * as vscode from 'vscode';
import { ClaudeContextHoverProvider } from './providers/hoverProvider';
import { processSessionsForProject } from './commands/processSession';

export function activate(context: vscode.ExtensionContext) {
  console.log('Claude Context extension activated');
  
  // Register hover provider for all supported languages
  const languages = ['typescript', 'javascript', 'python', 'rust', 'go', 'java', 'c', 'cpp'];
  
  for (const language of languages) {
    context.subscriptions.push(
      vscode.languages.registerHoverProvider(
        { scheme: 'file', language },
        new ClaudeContextHoverProvider()
      )
    );
  }
  
  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeContext.processCurrentProject', async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
      }
      
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Processing Claude sessions...',
          cancellable: false
        },
        async () => {
          const result = await processSessionsForProject(workspaceFolder.uri.fsPath);
          vscode.window.showInformationMessage(
            `Processed ${result.sessionsProcessed} sessions, linked ${result.commitsLinked} commits`
          );
        }
      );
    })
  );
  
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeContext.viewSessionForLine', async (args: { sessionId: string }) => {
      // TODO: Open webview with full session transcript
      vscode.window.showInformationMessage(`Session: ${args.sessionId}`);
    })
  );
}

export function deactivate() {}
```

---

## MVP Scope

### Must Have (v0.1)

- [ ] Parse Claude Code JSONL files
- [ ] Match Edit operations to git commits via exact string matching
- [ ] Store context in git notes (`refs/notes/claude-context`)
- [ ] VS Code hover provider: line → git blame → note lookup → display
- [ ] Command: "Process Sessions for Current Project"
- [ ] Handle standard `~/.claude` config location

### Should Have (v0.2)

- [ ] Gutter decorations (icon for lines with Claude context)
- [ ] Support MultiEdit and Write operations
- [ ] Handle custom Claude config paths
- [ ] View full session command (webview)
- [ ] Git hook for automatic processing on commit

### Won't Have (MVP)

- Fuzzy matching (accuracy over coverage)
- Cross-session analysis
- Team sync / shared context
- Decision extraction
- Search functionality
- Cursor/Windsurf support (Claude Code only for MVP)

---

## Testing the Implementation

### Test Case 1: Basic Edit Matching

Given this JSONL entry:
```json
{
  "type": "assistant",
  "sessionId": "abc-123",
  "message": {
    "content": [
      { "type": "text", "text": "I'll rename the variable for clarity." },
      { 
        "type": "tool_use", 
        "name": "Edit",
        "input": {
          "file_path": "/path/to/file.ts",
          "old_string": "const t = trips[0];",
          "new_string": "const trip = trips[0];"
        }
      }
    ]
  }
}
```

And this git commit:
```diff
commit def456
-const t = trips[0];
+const trip = trips[0];
```

Expected: Commit `def456` gets a note with sessionId `abc-123` and reasoning "I'll rename the variable for clarity."

### Test Case 2: No Match (Human Edit)

If a commit exists that wasn't made by Claude (no matching JSONL entry), no note should be attached.

### Test Case 3: Renamed File

If `git log --follow` shows a file was renamed, we should still match edits to the original filename.

---

## Notes on Cursor Compatibility

The extension should work in Cursor (it's VS Code-based), but Cursor has its own AI conversation history format. For MVP, we only support Claude Code's JSONL format. Future versions could add parsers for:

- Cursor's conversation storage (location TBD)
- Windsurf/Codeium format
- Copilot (if it stores conversations)

---

## Questions for Implementation

1. **Performance:** For large repos with many sessions, should we add a local SQLite cache as an index, or is git notes lookup fast enough?

2. **Incremental processing:** How do we track which sessions have already been processed? Store last-processed timestamp?

3. **Note conflicts:** If two sessions touched the same commit, how should we merge the notes?

4. **Special characters:** Shell escaping for git commands with strings containing quotes, newlines, etc.

---

## Success Criteria

The MVP is successful if:

1. Given a project with Claude Code sessions, running "Process Sessions" creates git notes
2. Hovering over a line that was edited by Claude shows the reasoning
3. The matching is 100% accurate (no false positives)
4. It's okay to miss some matches (false negatives acceptable for MVP)
