# How clawd-blame Works

## The Problem

Claude Code edits your files, commits the changes, and moves on. Later, when you're reading the code, you have no idea *why* Claude made a particular decision. The reasoning is buried in JSONL session logs that nobody reads.

## The Solution

clawd-blame attaches Claude's reasoning directly to git commits as **git notes**, then surfaces that reasoning as a hover tooltip when you mouse over any line Claude wrote.

---

## Data Flow

```
~/.claude/projects/<project>/   ──►   git notes   ──►   hover tooltip
       (JSONL sessions)            (refs/notes/        (VS Code hover)
                                    claude-context)
```

### Step 1: Process Sessions (manual trigger)

Run **"Clawd Blame: Process Sessions for Current Project"** from the command palette. This kicks off the processing pipeline:

```
JSONL files on disk
        │
        ▼
   Parse each line ──► filter sidechain entries
        │                filter non-assistant entries
        ▼                group by requestId
   Extract edits ──► Edit, Write, MultiEdit tool_use blocks
        │              + reasoning from text blocks in same group
        ▼              + user intent from parentUuid chain
   Match to commits ──► git log -S (pickaxe) finds which commit
        │                 introduced the old_string → new_string change
        ▼                 git show verifies the diff
   Write git notes ──► JSON stored under refs/notes/claude-context
                         keyed by commit SHA
```

### Step 2: Hover (automatic)

Every time you hover over a line in any file:

```
Cursor position
      │
      ▼
  git blame ──► commit SHA for this line
      │
      ▼
  git notes show ──► read JSON note for this commit (cached)
      │
      ▼
  Match file path ──► find the edit entry for this specific file
      │
      ▼
  Render tooltip ──► "You asked: ...", "Claude's reasoning: ..."
```

---

## What Gets Stored

Each git note is a JSON object attached to a commit SHA:

```json
{
  "sessionId": "abc123-def456",
  "edits": [
    {
      "filePath": "src/utils/parser.ts",
      "reasoning": "I'll use a readline stream to handle large files without loading them entirely into memory...",
      "intent": "parse the JSONL session files",
      "timestamp": "2025-01-15T10:30:00Z"
    }
  ]
}
```

Multiple processing runs merge into the same note — edits accumulate.

---

## Where Things Live

| What | Where |
|------|-------|
| Session logs | `~/.claude/projects/<encoded-project-path>/*.jsonl` |
| Git notes | `refs/notes/claude-context` (local to repo) |
| Processing state | VS Code `workspaceState` (tracks which sessions were already processed) |
| Note cache | In-memory Map (cleared on each processing run) |

---

## JSONL Parsing Details

Claude Code's JSONL format has a few quirks the parser handles:

- **Streaming splits responses across multiple entries.** A single Claude response produces 2-3 JSONL entries. Text blocks and tool_use blocks land in separate entries. They share a `requestId`, which is how the parser groups them back together.

- **User message content can be a string or an array of content blocks.** The parser handles both.

- **`isSidechain: true` entries** are branched conversations that may not reflect final code. Skipped.

- **Entries without a `message` field** (like `file-history-snapshot`, `progress`, `system`) are skipped via a type guard.

- **Reasoning comes from text blocks only**, not thinking blocks. Thinking blocks are internal chain-of-thought and too verbose for a tooltip.

---

## Commit Matching

The trickiest part — how do we know which commit corresponds to a given edit?

**For Edit/MultiEdit** (has `old_string` → `new_string`):
1. Run `git log -S <old_string>` (pickaxe search) to find commits that changed the count of that string in the file
2. For each candidate, run `git show` and verify the diff contains both the removal of `old_string` and addition of `new_string`
3. Return the first verified match

**For Write** (new file creation):
1. Run `git log --diff-filter=A` to find the commit that added the file
2. Return the first result

Pickaxe search is bounded to the last 200 commits to keep it fast. False negatives (missing a match) are acceptable — the tooltip just won't appear for that line.

---

## Security Decisions

- **No shell execution.** All git commands use `execFile`/`spawn` with argument arrays. A `new_string` containing `$(rm -rf /)` is just an argument, not a command.

- **JSON boundary validation.** All `JSON.parse` calls go through type guard functions that validate the shape before the data enters the pipeline.

- **Markdown escaping.** Intent and reasoning strings are escaped before rendering in the hover tooltip. `MarkdownString.isTrusted` is left as `false` (the default), preventing command URI execution.

---

## Sharing Notes

Git notes live in `refs/notes/claude-context` and are local by default. To share with a team:

```sh
# Push
git push origin refs/notes/claude-context

# Fetch
git fetch origin refs/notes/claude-context:refs/notes/claude-context
```
