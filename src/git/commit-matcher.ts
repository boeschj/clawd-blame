import * as path from "node:path";

import { MAX_PICKAXE_COMMITS } from "../constants.js";
import type { ParsedEdit } from "../types.js";
import { runGit } from "./executor.js";

export async function findCommitForEdit(
  repoPath: string,
  edit: ParsedEdit,
): Promise<string | null> {
  const relativePath = path.relative(repoPath, edit.filePath);

  if (edit.oldString === null) {
    return findCommitForNewFile(repoPath, relativePath);
  }

  return findCommitForStringChange(
    repoPath,
    relativePath,
    edit.oldString,
    edit.newString,
  );
}

async function findCommitForNewFile(
  repoPath: string,
  relativePath: string,
): Promise<string | null> {
  try {
    const output = await runGit(repoPath, [
      "log",
      "--diff-filter=A",
      "--format=%H",
      "--",
      relativePath,
    ]);

    const firstLine = output.trim().split("\n")[0];
    return firstLine || null;
  } catch {
    return null;
  }
}

async function findCommitForStringChange(
  repoPath: string,
  relativePath: string,
  oldString: string,
  newString: string,
): Promise<string | null> {
  try {
    const candidates = await findPickaxeCandidates(
      repoPath,
      relativePath,
      oldString,
    );

    for (const sha of candidates) {
      const isMatch = await verifyDiffContainsChange(
        repoPath,
        sha,
        relativePath,
        oldString,
        newString,
      );
      if (isMatch) {
        return sha;
      }
    }

    return null;
  } catch {
    return null;
  }
}

async function findPickaxeCandidates(
  repoPath: string,
  relativePath: string,
  searchString: string,
): Promise<string[]> {
  const output = await runGit(repoPath, [
    "log",
    `-S`,
    searchString,
    `--max-count=${MAX_PICKAXE_COMMITS}`,
    "--format=%H",
    "--",
    relativePath,
  ]);

  return output
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
}

async function verifyDiffContainsChange(
  repoPath: string,
  sha: string,
  relativePath: string,
  oldString: string,
  newString: string,
): Promise<boolean> {
  try {
    const diff = await runGit(repoPath, [
      "show",
      "--format=",
      sha,
      "--",
      relativePath,
    ]);

    const hasOldStringRemoval = diff.includes(`-${oldString}`);
    const hasNewStringAddition = diff.includes(`+${newString}`);

    return hasOldStringRemoval && hasNewStringAddition;
  } catch {
    return false;
  }
}
