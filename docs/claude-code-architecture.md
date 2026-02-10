# Claude Code's on-device architecture: a complete technical deep dive

Claude Code stores all local state in a well-defined hierarchy rooted at **`~/.claude/`**, complemented by project-level `.claude/` directories and system-level enterprise paths. The architecture spans seven interconnected subsystems — settings, memory (CLAUDE.md), credentials, sessions, hooks, MCP servers, and plugins — each with distinct file formats, precedence rules, and storage locations. This report documents every known file, directory, and configuration surface as of early 2026.

---

## The global `~/.claude/` directory and its complete file tree

The **`~/.claude/`** directory is Claude Code's primary configuration home. Every user-level config, session transcript, credential, and cache lives here. The `CLAUDE_CONFIG_DIR` environment variable can override this location. On some systems running v1.0.30+, a migration to `~/.config/claude/` has been observed, though `~/.claude/` remains standard for most installations.

Platform-specific base paths are straightforward: **`/Users/<user>/.claude/`** on macOS, **`/home/<user>/.claude/`** on Linux, **`C:\Users\<user>\.claude\`** on Windows, and the Linux path again under WSL.

The complete directory tree:

```
~/.claude/
├── settings.json                # Global user settings (JSON, user-editable)
├── settings.local.json          # Machine-specific overrides, not synced (JSON)
├── CLAUDE.md                    # Global memory/instructions for all projects
├── .credentials.json            # OAuth/API credentials (Linux/Windows only)
├── history.jsonl                # Session history index (metadata)
├── rules/                       # Modular user-level rule files (.md)
├── commands/                    # Global custom slash commands (.md)
├── projects/                    # Session transcripts per project
│   └── -Users-sean-myproject/
│       ├── <session-uuid>.jsonl
│       └── <session-uuid>/session-memory/summary.md
├── file-history/                # File edit backups (by content hash)
├── session-env/                 # Per-session environment variables
├── tasks/                       # Task coordination (lock files)
├── todos/                       # Legacy todo storage (JSON)
├── shell-snapshots/             # Shell state snapshots for rollback
├── plugins/                     # Plugin management
│   ├── config.json
│   ├── installed_plugins.json
│   └── known_marketplaces.json
├── skills/                      # User-level skills
├── agents/                      # User-level custom agent definitions (.md)
├── statsig/                     # Analytics/feature-flag cache
├── telemetry/                   # Telemetry data
├── debug/                       # Debug logs
├── plans/                       # Plan mode storage
└── local/                       # npm-local install artifacts (legacy)
```

A separate file, **`~/.claude.json`** (outside the `.claude/` directory), serves as a multi-purpose legacy/active configuration store containing user preferences (theme, notifications, editor mode), OAuth session metadata (email, user IDs, org IDs), MCP server configurations (user and local scopes), per-project state (allowed tools, trust settings), and conversation history in a `"history"` array. This file can grow to hundreds of megabytes due to history accumulation and has been flagged as a privacy concern in multiple GitHub issues.

Project-level files live in your working directory:

```
./
├── CLAUDE.md                    # Project memory (team-shared, committed to VCS)
├── CLAUDE.local.md              # Personal project memory (auto-gitignored)
├── .mcp.json                    # Project-scoped MCP server configuration
└── .claude/
    ├── CLAUDE.md                # Alternative project memory location
    ├── settings.json            # Project settings (version controlled)
    ├── settings.local.json      # Local project overrides (gitignored)
    ├── .gitignore               # Auto-generated to ignore local files
    ├── rules/                   # Modular project instruction files (.md)
    ├── commands/                # Project slash commands (.md)
    └── agents/                  # Project agent definitions (.md)
```

Enterprise administrators deploy managed configurations to system-level paths: **`/Library/Application Support/ClaudeCode/`** on macOS, **`/etc/claude-code/`** on Linux/WSL, and **`C:\Program Files\ClaudeCode\`** on Windows. These directories contain `managed-settings.json`, `managed-mcp.json`, and optionally a managed `CLAUDE.md` — all with the highest precedence in the system.

---

## The CLAUDE.md memory system and how files are discovered

CLAUDE.md files form a **hierarchical memory system** loaded automatically into Claude Code's context at startup. Four officially documented memory locations exist, listed from highest to lowest priority:

1. **Enterprise policy** — System-level paths (e.g., `/Library/Application Support/ClaudeCode/CLAUDE.md`)
2. **Project memory** — `./CLAUDE.md` or `./.claude/CLAUDE.md`
3. **User memory** — `~/.claude/CLAUDE.md`
4. **Project local memory** — `./CLAUDE.local.md`

All levels **combine** rather than replace each other; content is concatenated into the system context. On conflicts, higher-priority files take precedence. Discovery uses **recursive upward traversal**: starting from the current working directory, Claude Code walks up to (but not including) the root, loading any `CLAUDE.md` or `CLAUDE.local.md` files found along the way. Subdirectory CLAUDE.md files are discovered but **lazily loaded** — they enter context only when Claude reads files in those subtrees.

The **`@import` syntax** enables file references within CLAUDE.md: `@path/to/file` imports content inline, with relative paths resolving relative to the containing file. Home directory expansion (`@~/.claude/my-instructions.md`) is supported. Imports have a maximum recursive depth of **5 hops** and a cap of **2,000 lines** per imported file. Imports inside code blocks or backtick spans are not evaluated.

The **`.claude/rules/`** directory (introduced in v2.0.64) extends this system with modular rule files. All `.md` files in this directory load at the same priority as `.claude/CLAUDE.md`. Rules support YAML frontmatter for path-scoped conditional loading:

```yaml
---
paths:
  - "src/api/**/*.ts"
---
# API Development Rules
Only use async/await patterns in API routes.
```

CLAUDE.md content is injected into the system context area and wrapped with `<system-reminder>` tags indicating the content may or may not be relevant to the current task. There is **no explicit size limit** on CLAUDE.md files, but content counts against the **200K token context window** (500K for Enterprise with Sonnet 4.5). Community consensus recommends keeping files under **300 lines**, with expert practitioners targeting under 60 lines for the root file.

Key management commands include `/init` (auto-generates a foundational CLAUDE.md by analyzing the codebase), `/memory` (opens memory files for editing), and starting input with `#` to quickly append to a memory file.

---

## Settings hierarchy, schema, and every known configuration key

Claude Code's settings system uses **hierarchical JSON files** merged with a strict precedence order. From highest to lowest:

1. **Enterprise managed** — `managed-settings.json` (cannot be overridden)
2. **CLI flags** — `--allowedTools`, `--model`, `--permission-mode`
3. **Local project** — `.claude/settings.local.json`
4. **Shared project** — `.claude/settings.json`
5. **Local user** — `~/.claude/settings.local.json`
6. **User global** — `~/.claude/settings.json`

All settings files support the `$schema` property for IDE autocompletion: `"$schema": "https://json.schemastore.org/claude-code-settings.json"`. Claude Code automatically creates timestamped backups, retaining the **5 most recent**.

The complete set of documented top-level keys includes `permissions` (with `allow`, `deny`, `ask` arrays using prefix-matching rules), `hooks` (lifecycle event handlers), `env` (environment variables), `model` (override default model), `sandbox` (bash sandboxing with network controls), `cleanupPeriodDays` (session retention, default **30**), `includeCoAuthoredBy` (git attribution), `apiKeyHelper` (shell script for dynamic API keys), `statusLine` (custom status display), `outputStyle` (system prompt style adjustment), `companyAnnouncements` (startup messages), `forceLoginMethod` and `forceLoginOrgUUID` (authentication controls), and MCP-related keys (`enableAllProjectMcpServers`, `enabledMcpjsonServers`, `disabledMcpjsonServers`, `allowedMcpServers`, `deniedMcpServers`). Plugin configuration uses `enabledPlugins` (map of plugin identifiers to booleans) and `extraKnownMarketplaces` (additional plugin sources).

Permission rules follow a specific syntax: `ToolName` permits all actions of that type, `ToolName(pattern)` permits matching calls only (e.g., `Bash(npm run:*)`), `ToolName(**)` uses gitignore-style wildcards for paths, and `WebFetch(domain:example.com)` enables domain-specific rules. MCP tools use the format `mcp__servername__toolname`. **Evaluation order is deny → allow → ask → default prompt**, with deny always taking absolute precedence.

The environment variable surface is extensive — over **60 documented variables** control everything from model selection (`ANTHROPIC_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`) to proxy configuration (`HTTP_PROXY`, `HTTPS_PROXY`), authentication (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`), bash behavior (`BASH_DEFAULT_TIMEOUT_MS`, `BASH_MAX_OUTPUT_LENGTH`), MCP timeouts (`MCP_TIMEOUT`, `MCP_TOOL_TIMEOUT`), telemetry (`DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`), and mTLS (`CLAUDE_CODE_CLIENT_CERT`, `CLAUDE_CODE_CLIENT_KEY`).

---

## Authentication and credential storage across platforms

Claude Code's credential storage is **platform-dependent**. On macOS, credentials are stored in the **system Keychain** under the service name `"Claude Code-credentials"` (write) and `"Claude Code"` (read) — a naming inconsistency that has caused known bugs. The stored value is a JSON blob containing OAuth tokens:

```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat01-...",
    "refreshToken": "sk-ant-ort01-...",
    "expiresAt": 1748658860401,
    "scopes": ["user:inference", "user:profile"]
  }
}
```

On **Linux and Windows**, credentials fall back to **`~/.claude/.credentials.json`** with the same JSON structure. This file should have `chmod 600` permissions. Three environment variable alternatives bypass file-based storage entirely: `ANTHROPIC_API_KEY` for direct API key authentication, `CLAUDE_CODE_OAUTH_TOKEN` for passing OAuth tokens, and the `apiKeyHelper` setting which executes a shell script to dynamically generate credentials (refreshed after 5 minutes or on HTTP 401, with custom TTL via `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`).

---

## Hooks: 12 lifecycle events with three execution types

Claude Code's hook system provides **12 lifecycle events** where user-defined commands execute automatically. Hooks are configured in the `"hooks"` property of any settings file and use a three-level nesting structure: event → matcher group → handler array.

The complete event catalog:

- **PreToolUse** — fires after Claude generates tool parameters, before execution; can allow, deny, or modify tool input via `updatedInput`
- **PermissionRequest** — fires when a permission dialog would be shown; can auto-allow or deny
- **PostToolUse** — fires after successful tool execution; can provide feedback
- **PostToolUseFailure** — fires after tool failure (SDK only)
- **Notification** — fires on notifications (matchers: `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`)
- **UserPromptSubmit** — fires when user submits a prompt, before processing; can block or inject context
- **Stop** / **SubagentStop** — fires when agent/subagent finishes responding; can force continuation
- **SubagentStart** — fires when a subagent spawns (SDK)
- **PreCompact** — fires before compaction (matchers: `manual`, `auto`)
- **SessionStart** — fires on session start/resume (matchers: `startup`, `resume`, `clear`, `compact`)
- **SessionEnd** — fires on session end; cannot block termination

Three handler types exist: **command** (bash subprocess), **prompt** (single-turn LLM evaluation via Haiku), and **agent** (subagent with tool access). Matchers use **case-sensitive regex** against tool names — `"Edit|Write|MultiEdit"` matches multiple tools, `"mcp__memory__.*"` matches an entire MCP server, and `"Bash(npm test*)"` filters by argument pattern.

The stdin/stdout protocol passes JSON context via stdin and interprets exit codes for control flow: **exit 0** means success (stdout parsed for JSON output), **exit 2** means blocking error (stderr fed back to Claude), and any other exit code is a non-blocking error. On exit 0, structured JSON output can include `decision`, `reason`, `updatedInput`, `additionalContext`, and `permissionDecision` fields. All matching hooks for an event run **in parallel**, with automatic deduplication of identical commands.

A representative configuration:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": ".claude/hooks/validate-command.sh",
            "timeout": 30
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "npx prettier --write $(jq -r '.tool_input.file_path')"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Evaluate if all tasks are complete. Context: $ARGUMENTS"
          }
        ]
      }
    ]
  }
}
```

Environment variables available to hooks include `CLAUDE_PROJECT_DIR` (project root), `CLAUDE_CODE_REMOTE` (set to `"true"` in remote environments), and `CLAUDE_ENV_FILE` (for persisting env vars, SessionStart only). Hooks are snapshotted at session startup; mid-session changes require review via the `/hooks` interactive menu.

---

## MCP server integration and plugin architecture

Claude Code extends its capabilities through **MCP (Model Context Protocol)** — Anthropic's open-source standard for AI-tool integrations using **JSON-RPC 2.0**. Claude Code acts as an MCP client connecting to external servers that expose tools, resources, and prompts.

MCP configuration lives in **three scoped locations**:

- **User scope** — `~/.claude.json` under the `mcpServers` key (available across all projects)
- **Project scope** — `.mcp.json` in the project root (version controlled, shared with team)
- **Enterprise managed** — `managed-mcp.json` at system-level paths (highest precedence)

Two transport types are actively supported: **stdio** (local subprocess communicating via stdin/stdout) and **HTTP/Streamable HTTP** (remote servers, recommended for cloud services). SSE transport exists but is deprecated.

The JSON configuration format for a stdio server:

```json
{
  "mcpServers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxxxx" }
    }
  }
}
```

For HTTP servers: `{"type": "http", "url": "https://mcp.example.com/mcp", "headers": {"Authorization": "Bearer token"}}`. Project `.mcp.json` files support environment variable expansion with `${VAR}` and `${VAR:-default}` syntax in all fields.

The **`claude mcp` CLI** provides complete management: `add` (with `--transport stdio|http|sse` and `--scope local|project|user`), `add-json`, `add-from-claude-desktop`, `list`, `get`, `remove`, `reset-project-choices`, and `serve` (which exposes Claude Code itself as an MCP server). MCP tools appear in Claude Code with the naming format **`mcp__<server>__<tool>`** and follow the standard permission system — permissions can be configured with patterns like `mcp__puppeteer__*` to match all tools from a server.

MCP output is capped at **25,000 tokens** by default (configurable via `MAX_MCP_OUTPUT_TOKENS`), with warnings at 10,000 tokens.

The **plugin system** builds on MCP, with plugins registered via `enabledPlugins` in settings and sourced from marketplaces configured in `extraKnownMarketplaces`. Plugin state is tracked in `~/.claude/plugins/` (containing `config.json`, `installed_plugins.json`, and `known_marketplaces.json`). Plugins can bundle their own MCP servers, hooks (via `hooks/hooks.json`), and slash commands, with `${CLAUDE_PLUGIN_ROOT}` resolving to the plugin's installation directory.

---

## Session persistence: JSONL transcripts and the resume model

Each session receives a **UUID v4** identifier and is stored as a JSONL (JSON Lines) file at:

```
~/.claude/projects/<path-encoded-project-dir>/<session-uuid>.jsonl
```

Path encoding converts slashes to dashes: `/Users/sean/myproject` becomes `-Users-sean-myproject`. Each line in the JSONL file represents one event — user messages, assistant responses (including thinking blocks, tool calls, and token usage), file history snapshots, and summaries. Messages are linked via `uuid` and `parentUuid` fields, forming a traceable chain for full session replay.

A representative JSONL entry:

```jsonl
{"type":"assistant","uuid":"e684816e-...","parentUuid":"7d90e1c9-...","message":{"role":"assistant","model":"claude-sonnet-4-20250514","content":[{"type":"thinking","thinking":"..."},{"type":"text","text":"Let me analyze the structure."},{"type":"tool_use","id":"toolu_01ABC","name":"Bash","input":{"command":"ls -la"}}],"usage":{"input_tokens":1500,"output_tokens":200,"cache_read_input_tokens":50000}}}
```

**Session resumption** is supported through several CLI flags: `--continue` (or `-c`) resumes the most recent conversation in the current directory, `--resume` opens an interactive session picker showing summaries, timestamps, message counts, and git branches, and `--resume <session-id>` targets a specific session. On resume, a **new UUID** is generated while the original conversation history is loaded. Auto-compaction triggers at approximately **80% context window** usage, summarizing older conversation to stay under the token limit.

The **Session Memory** feature (v2.0.64+) generates automatic summaries stored at `~/.claude/projects/<path>/<session-uuid>/session-memory/summary.md`, extracted in the background after ~10K tokens and then every ~5K tokens or 3 tool calls. File edit backups are stored by content hash in `~/.claude/file-history/` for undo/rewind operations.

Session cleanup is controlled by **`cleanupPeriodDays`** (default: **30 days**). Sessions inactive longer than this period are deleted at startup. Setting the value to `0` immediately purges all sessions.

---

## Conclusion

Claude Code's on-device architecture is a layered system designed around **hierarchical precedence** — enterprise settings override project settings which override user settings, applied consistently across memory files, configuration, hooks, MCP servers, and permissions. The architecture makes three key design choices worth noting. First, **JSONL as the session format** enables append-only writes and streaming replay but contributes to storage growth over time. Second, the **separation of `~/.claude.json` (legacy multi-purpose) from `~/.claude/settings.json` (modern structured settings)** reflects an ongoing migration that users should be aware of — `~/.claude.json` remains critical for MCP server state and per-project tool approvals. Third, the **hook system's stdin/stdout JSON-RPC protocol** with exit-code-based control flow provides a clean, language-agnostic extension model that makes Claude Code programmable at every lifecycle stage without modifying its internals. The modular rules system (`rules/*.md` with YAML frontmatter for path scoping) represents the newest evolution, moving away from monolithic CLAUDE.md files toward composable, conditionally-loaded instruction sets.