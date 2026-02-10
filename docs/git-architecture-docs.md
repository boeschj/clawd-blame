# Git internals: a deep technical analysis of metadata and change detection

Git is a content-addressable filesystem masquerading as a version control system, and understanding its internal architecture is essential for anyone building tools that interact with it programmatically. **Git stores every file as a hashed blob, organizes blobs into Merkle trees, and chains snapshots through commit objects that form a directed acyclic graph (DAG)**—a design that enables both its metadata flexibility and its change-detection speed. This report covers the full depth of Git's mechanisms for attaching metadata to commits and detecting changes between versions, drawing from official Git documentation, Git internals specifications, and Anthropic's Claude Code documentation for practical integration context.

---

## The four object types that underpin everything

Git's entire data model rests on four object types stored in a content-addressable object database under `.git/objects/`. Every object follows the same storage pattern: a header (`<type> <size>\0`) concatenated with content, SHA-1 hashed to produce a 40-character hex identifier, then zlib-compressed and written to `.git/objects/<first-2-hex>/<remaining-38-hex>`.

**Blob objects** store raw file content with zero metadata—no filename, no permissions, nothing. Two files with identical content anywhere in the repository's history produce the same blob hash and are stored exactly once. This deduplication is automatic and fundamental. You can create and inspect blobs directly:

```bash
echo "Hello" | git hash-object -w --stdin   # af5626b...
git cat-file -p af5626b                       # prints "Hello"
```

**Tree objects** represent directory snapshots. Each entry in a tree is a binary record containing a mode (`100644` for regular files, `100755` for executables, `040000` for subdirectories, `120000` for symlinks, `160000` for submodule gitlinks), a filename, and the 20-byte raw SHA-1 pointing to a blob or another tree. Entries are sorted by `memcmp` byte order. Because a tree's hash incorporates the hashes of all its children, trees form a **Merkle tree**—any change to any file propagates upward, changing every ancestor tree hash up to the root.

**Commit objects** are text records linking a root tree (the complete project snapshot) to zero or more parent commits, plus author/committer metadata and a message:

```
tree eebfed94e75e7760540d1485c740902590a00332
parent 04b871796dc0420f8e7561a895b52484b701d51a
author Alice <alice@example.com> 1643973987 +0000
committer Bob <bob@example.com> 1643974087 +0000
gpgsig -----BEGIN PGP SIGNATURE-----
 <base64 data>
 -----END PGP SIGNATURE-----

Fix critical parser bug in JSON handling
```

The header section uses key-value pairs with RFC 822-style multi-line continuation (leading spaces). After a blank line, the entire remainder is the commit message. The **author** records who wrote the change; the **committer** records who last applied it—these diverge during rebase, cherry-pick, and `format-patch`/`am` workflows.

**Tag objects** (annotated tags) reference any other object with a tagger, timestamp, and message. Lightweight tags are simply ref files pointing directly to commits and create no object.

---

## Seven mechanisms for attaching metadata to commits

Git provides a surprisingly rich set of mechanisms for associating metadata with commits, each with different trade-offs around mutability, shareability, and machine-parseability.

### Commit messages and their internal structure

The commit message is the most visible metadata carrier. It's stored as part of the commit object itself, making it **immutable**—any change produces a new commit with a new SHA. Git imposes no structural requirements, but the widely adopted convention uses a subject line (≤50 characters, imperative mood), a blank separator, and a body wrapped at 72 characters. The Conventional Commits specification (`<type>[scope]: <description>`) adds machine-parseable structure that maps to semantic versioning: `fix` → PATCH, `feat` → MINOR, `BREAKING CHANGE` footer → MAJOR.

Encoding defaults to UTF-8. Non-UTF-8 messages declare their encoding via an `encoding` header in the commit object, and display commands like `git log` transcode using `i18n.logOutputEncoding`. Commit messages are accessible via plumbing (`git cat-file -p`) and porcelain (`git log --format=%B` for the full raw body, `%s` for subject, `%b` for body).

### Commit trailers: structured key-value metadata

Trailers are `Key: Value` pairs at the end of the commit message, separated from the body by a blank line. They follow RFC 822 header conventions and have become the standard way to embed structured metadata:

```
Signed-off-by: Alice <alice@example.com>
Co-authored-by: Carol <carol@example.com>
Fixes: #42
Change-Id: I1234567890abcdef
```

Git's trailer parser (`git interpret-trailers --parse`) identifies trailer blocks by looking for a group of lines at the message's end that is either all trailers or at least **25% trailers** with at least one recognized trailer present. The `git commit --trailer` flag (Git 2.32+) adds trailers at commit time. Configuration options control placement (`trailer.where`), deduplication (`trailer.ifexists`), and automatic generation (`trailer.<token>.cmd`).

Standard trailers include `Signed-off-by` (Developer Certificate of Origin), `Co-authored-by` (multi-author attribution recognized by GitHub and GitLab), `Reviewed-by`, `Acked-by`, `Tested-by`, `Fixes` (bug-introducing commit reference), and `Change-Id` (Gerrit review identifier). Programmatic extraction uses `git log --format="%(trailers:key=Co-authored-by,valueonly,separator=,)"`.

Claude Code uses trailers for **commit attribution**, appending `Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>` by default. This is configurable through the `attribution.commit` setting, and the `includeCoAuthoredBy` flag can disable it entirely.

### Git notes: post-hoc annotation without rewriting history

Git notes are the only mechanism that attaches metadata to commits **without modifying their SHA**. Notes are stored as a separate tree structure under a special ref (default: `refs/notes/commits`). Each entry in the notes tree uses the annotated commit's SHA as its filename, pointing to a blob containing the note text. For performance, the notes tree uses fan-out directories (splitting SHAs into path components).

Every note modification creates a new commit on the notes ref, giving notes their own independent history. Multiple namespaces enable organizing different metadata types:

```bash
git notes --ref=jenkins add -m "Build #847: PASS" abc1234
git notes --ref=security add -m "CVE scan clean" abc1234
git log --show-notes='*'    # display all namespaces
```

Notes are **not pushed or fetched by default**—you must explicitly configure refspecs (`fetch = +refs/notes/*:refs/notes/*`). Notes merge strategies include `ours`, `theirs`, `union`, and `cat_sort_uniq`. Real-world systems like **Gerrit** store review metadata under `refs/notes/review`, and Google's **git-appraise** builds entire distributed code review on notes.

The key limitation: only one note per object per namespace, and most hosting platforms (including GitHub) provide no UI for notes.

### Tags: lightweight and annotated

**Lightweight tags** are bare refs in `.git/refs/tags/<name>` pointing directly to a commit SHA. They carry no metadata. **Annotated tags** create a full tag object containing the target object hash, tagger identity, timestamp, message, and optionally a cryptographic signature. The ref then points to the tag object, which points to the commit—one additional indirection hop.

Signed tags (`git tag -s`) append GPG, SSH, or X.509 signatures to the tag object. When merging a signed tag, Git embeds the **entire tag object** (including signature) as a `mergetag` header in the merge commit, preserving verification capability independent of the tag ref. Git 2.46.0 added `--trailer` support for tags.

`git describe` finds the nearest annotated tag reachable from a commit and produces human-readable identifiers like `v2.37.0-3-g378b519` (tag name, commits since tag, abbreviated hash). It ignores lightweight tags by default.

### Refs, symbolic refs, and the reflog

References are named pointers stored in `.git/refs/` (or packed in `.git/packed-refs`). The hierarchy includes `refs/heads/` (branches), `refs/tags/`, `refs/remotes/` (remote-tracking), `refs/notes/`, `refs/replace/`, and `refs/stash`. HEAD is typically a symbolic ref (`ref: refs/heads/main`) managed via `git symbolic-ref`.

Special refs provide operational state: **MERGE_HEAD** (commits being merged), **CHERRY_PICK_HEAD**, **REVERT_HEAD**, **REBASE_HEAD**, **ORIG_HEAD** (backup before drastic operations), and **FETCH_HEAD** (most recently fetched).

The **reflog** records every ref update as an append-only log in `.git/logs/`, with each entry containing old SHA, new SHA, identity, timestamp, and operation description. This enables time-based recovery (`HEAD@{yesterday}`, `main@{2.hours.ago}`) and serves as a safety net against accidental history loss. Reachable reflog entries expire after **90 days**, unreachable after **30 days** (configurable via `gc.reflogExpire`). Reflogs are strictly local—never pushed or shared.

Newer Git versions support the **reftable format**, a compact binary structure storing refs and reflogs together under `.git/reftable/`, replacing the filesystem-based approach with better atomicity and performance.

### Cryptographic signatures on commits and tags

Commit signatures are stored as a `gpgsig` header in the commit object, using RFC 822 multi-line continuation. The signature covers all commit content except the `gpgsig` header itself. Three backends are supported: OpenPGP (`gpg`), SSH keys (Git 2.34+, via `gpg.format=ssh`), and X.509 certificates.

Configuration enables automatic signing (`commit.gpgSign=true`) and verification policies (`merge --verify-signatures` rejects unsigned commits). SSH key verification uses an `allowedSignersFile` mapping identities to trusted keys.

### Replace objects and grafts

`git replace` creates transparent object substitutions stored under `refs/replace/<original-sha>`, pointing to replacement objects. All Git commands use replacements by default (disable with `--no-replace-objects` or `GIT_NO_REPLACE_OBJECTS`). Replace refs can be pushed and fetched, making them suitable for shared history surgery—stitching separate repository histories or correcting metadata without rewriting.

**Grafts** (`.git/info/grafts`) are a deprecated local-only mechanism for overriding commit parentage. They should be migrated to replace objects via `git replace --convert-graft-file`.

---

## How Git detects changes: from stat() calls to Merkle tree walks

Git's change-detection system operates at multiple levels, each optimized for different comparison scenarios. The system is designed around a key insight: **most files don't change between operations**, so the fastest path is eliminating unchanged files without reading them.

### The index as a high-speed change cache

The `.git/index` file (the "staging area") is a binary structure that caches the state of every tracked file. Version 2 entries contain **40 bytes of filesystem stat data** per file: ctime, mtime (both with nanosecond precision), device number, inode, mode, uid, gid, file size, plus the blob's SHA-1 and a variable-length pathname.

When `git status` or `git diff` runs, Git calls `lstat()` on each working-tree file and compares the result against cached stat data. **If all stat fields match, Git skips reading the file entirely**—this is the critical optimization that keeps `git status` fast on repositories with hundreds of thousands of files.

When stat data differs, Git reads the file, hashes it, and compares the hash against the index entry's SHA-1 to determine if actual content changed. This two-tier approach (cheap stat comparison first, expensive hash comparison only when needed) is the core of Git's change-detection performance.

The **"racily clean" problem** occurs when a file is modified within the same filesystem-timestamp granularity as the index write. Git mitigates this by forcing content comparison (not just stat comparison) for entries whose mtime equals or exceeds the index file's own mtime, and by zeroing the cached size of suspect entries to force future content checks.

Index extensions add further acceleration: the **cache tree** stores pre-computed tree hashes for unchanged directory subtrees (allowing `git commit` to skip recomputing them); the **untracked cache** tracks untracked files per directory using directory mtimes; the **split index** reduces write costs by maintaining a read-only base plus a delta; and **sparse directory entries** (cone-mode sparse checkout) represent entire directories as single tree entries.

### Three-way status comparison

`git status` performs three distinct comparisons:

1. **HEAD tree vs. index** (`git diff-index --cached HEAD`): identifies staged changes ("Changes to be committed"). This is a tree-to-index comparison using the Merkle tree property—unchanged subtrees are identified by matching hashes and never traversed.

2. **Index vs. working tree** (`git diff-files`): identifies unstaged modifications using the stat-based fast path described above.

3. **Working tree scan for untracked files**: traverses directories not in the index, respecting `.gitignore` rules.

### Diff algorithms: Myers, patience, and histogram

When Git determines that two files differ, it computes an edit script using one of several algorithms.

**Myers diff** (the default) is based on Eugene Myers' 1986 paper. It models the problem as an edit graph: given sequences A (length N) and B (length M), construct an (N+1)×(M+1) grid where horizontal moves are deletions, vertical moves are insertions, and diagonal moves (matching elements) are free. The algorithm uses breadth-first search over "d-contours" (positions reachable with exactly d edits), greedily following maximal diagonal "snakes" after each edit. Time complexity is **O(ND)** where D is the edit distance—very fast for similar files, which is the common case. The linear-space refinement uses divide-and-conquer via a "middle snake" to achieve O(N) space.

**Patience diff** (Bram Cohen) preprocesses by finding lines that appear exactly once in both files, computing the Longest Increasing Subsequence of these unique matches, using them as fixed anchors, then applying Myers within each region between anchors. This produces **more readable diffs** when code contains many repeated lines (closing braces, blank lines, boilerplate), avoiding the pathological case where Myers matches structurally unrelated identical lines.

**Histogram diff** (originated in JGit by Shawn Pearce, ported to C Git in v1.7.7) builds occurrence histograms for each line and selects the **lowest-occurrence common element** as the split point—not just unique lines. When unique elements exist, it behaves identically to patience; when they don't, it picks the rarest element rather than falling back immediately. It's generally **faster than patience and often produces shorter diffs than Myers**.

Selection: `git diff --diff-algorithm=<name>` or `git config diff.algorithm histogram`. The `--minimal` flag forces Myers to iterate until a provably shortest diff is found, at higher CPU cost.

### The diffcore pipeline and rename detection

All three plumbing diff commands (`diff-tree`, `diff-index`, `diff-files`) produce an intermediate "filepair" list that passes through the **diffcore pipeline**: pathspec filtering → break detection (`-B`, splits large rewrites into delete+add) → **rename detection** (`-M`) → broken-pair re-merging → pickaxe filtering (`-S`/`-G`) → output ordering.

Rename detection first performs a fast exact-rename pass (identical blob hashes with different paths). For non-exact matches, it computes a **similarity score** using a rolling Rabin fingerprint hash to estimate shared content between deleted and added files. Pairs exceeding the threshold (default **50%**) are matched greedily in descending similarity order. Output shows `R086` for 86% similarity. Copy detection (`-C`) also checks modified files as potential sources.

The **pickaxe** (`-S<string>`) finds commits where the count of a string's occurrences changed—invaluable for tracking when specific code was introduced or removed. `-G<regex>` filters by patch text matching.

---

## Delta compression, pack files, and storage at scale

As repositories grow, Git transitions from loose objects to **packfiles** for storage efficiency. The `git gc` command triggers packing when loose objects exceed approximately 6,700 or pack count exceeds a threshold.

### Pack file internals

A packfile (`.pack`) contains a header (`PACK` signature, version 2, object count), followed by concatenated object entries, and a trailing SHA-1 checksum. Each entry has a variable-length header encoding the object type (3 bits) and uncompressed size, followed by zlib-deflated data.

Two special types enable delta compression: **OFS_DELTA** (base object referenced by negative offset within the same pack) and **REF_DELTA** (base object referenced by SHA-1). Delta instructions are binary, not unified diffs—they consist of **copy commands** (offset + length from base object) and **insert commands** (literal bytes). Git computes deltas using a rolling Rabin fingerprint hash to find matching byte sequences between objects.

Critical design choice: **the most recent version of a file is stored as the full object**, with older versions as deltas against it. This optimizes checkout speed for current state at the cost of slightly slower historical access. Delta chains can nest up to **50 levels deep** (configurable via `--depth`), and the packing window (`--window=10` default) controls how many candidate base objects are considered.

Objects are sorted by type, then basename, then size before packing—grouping similar files together for better delta compression. The **pack index** (v2 format) provides O(log N) lookups via a 256-entry fanout table, sorted object names, CRC32 checksums (enabling safe data copying between packs), and split 4-byte/8-byte offset tables for packs exceeding 2GB.

### Multi-pack indexes and bitmap acceleration

The **multi-pack index (MIDX)** provides a single index across all packfiles, eliminating the need to scan every `.idx` file for object lookups. **Bitmap indexes** store EWAH-compressed bitmaps indicating which objects are reachable from selected commits—each bit position corresponds to an object's position in pack order. Four type-level bitmaps (commits, trees, blobs, tags) dramatically accelerate `git rev-list --count`, clone/fetch negotiation, and reachability queries. GitHub relies on bitmaps extensively for hosting performance.

**Thin packs** optimize network transfer by referencing base objects not present in the pack (objects the receiver already has). The receiver "thickens" the pack by inserting missing bases.

### The commit-graph acceleration structure

The commit-graph file (`.git/objects/info/commit-graph`) is a binary structure storing pre-computed commit metadata in fixed-width records: root tree OID, first two parent positions, and a **generation number** combined with the commit timestamp. Generation numbers enable O(N) commit walks with early termination—if commit A has a lower generation than commit B, A cannot possibly reach B.

**Changed-path Bloom filters** (optional extension) encode which file paths changed in each commit, allowing `git log -- <path>` to skip commits without reading their trees. This provides roughly **10x improvement** for file-history queries on large repositories.

---

## The plumbing API: building systems on Git

For systems that interact with Git programmatically, the plumbing commands provide a stable, composable interface. The complete pipeline for creating a commit programmatically:

```bash
BLOB=$(echo "content" | git hash-object -w --stdin)
git update-index --add --cacheinfo 100644 $BLOB newfile.txt
TREE=$(git write-tree)
COMMIT=$(echo "My message" | git commit-tree $TREE -p HEAD)
git update-ref refs/heads/main $COMMIT
```

Key plumbing commands for metadata extraction include `git cat-file -p` (inspect any object), `git for-each-ref --format` (iterate refs with rich formatting), `git rev-parse` (resolve revision expressions), and `git rev-list` (walk the commit graph). Environment variables (`GIT_AUTHOR_NAME`, `GIT_COMMITTER_EMAIL`, `GIT_INDEX_FILE`) enable tools to override identity and operate on alternative index files for parallel operations.

**Git hooks** serve as metadata integration points: `prepare-commit-msg` can inject trailers from branch names, `commit-msg` can validate message format and add metadata via `git interpret-trailers`, and `post-commit` can annotate commits with notes. Claude Code documents protecting the `.git/` directory via PreToolUse hooks that block file operations targeting Git internals.

### Performance features for large repositories

Three features transform Git's performance at scale. **FSMonitor** (built-in daemon since Git 2.37) watches filesystem events and reports modified files since the last query, dropping `git status` from **12.2 seconds to 1.5 seconds** on Microsoft's Office repository (~700k files). **Sparse checkout in cone mode** (Git 2.25+) restricts pattern matching to directory-level operations, reducing pattern evaluation from 2,800 seconds to 1-2 seconds on repositories with millions of entries. **Scalar** (Git 2.38+) bundles all these optimizations—partial clone, sparse checkout, background maintenance, fsmonitor, commit-graph with Bloom filters, and MIDX—into a single command.

---

## How Claude Code integrates with Git

Anthropic's Claude Code treats Git as a first-class citizen. The tool operates through the Bash tool executing standard Git CLI commands rather than parsing `.git/` internals directly. Key integration points include conversational Git operations ("commit my changes with a descriptive message"), **automatic commit attribution** via configurable `Co-Authored-By` trailers, **Git worktree support** for parallel sessions with isolated file states, and custom slash commands that inject Git context via preprocessor directives (`!git diff HEAD`, `!git log --oneline -10`).

For web-based sessions, Claude Code routes all GitHub operations through a **dedicated security proxy** that manages authentication via scoped credentials, restricts push operations to the current working branch, and keeps sensitive credentials outside the sandbox. The diff view shows exactly what changed before creating pull requests. GitHub Actions and GitLab CI/CD integrations enable Claude to respond to PR mentions, create branches, implement changes, and open merge requests—all flowing through standard Git operations with appropriate permissions.

---

## Conclusion

Git's architecture achieves an elegant balance between simplicity (four object types, content-addressable storage) and power (Merkle integrity, flexible metadata mechanisms, sophisticated change detection). For system builders, the most important insights are these: **trailers are the best mechanism for structured metadata that should travel with commits**; **notes are the only way to annotate commits without rewriting history**; the **stat-based index is the key to Git's speed** and must be understood to build performant tools; and the **plumbing commands provide a stable, scriptable API** that decouples tool behavior from Git's evolving porcelain interface. The pack file format with delta compression, combined with acceleration structures like commit-graphs and bitmap indexes, enables Git to scale from single-developer projects to repositories with millions of files and millions of commits—a range no other version control system matches.