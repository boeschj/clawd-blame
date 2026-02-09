import { NULL_COMMIT_SHA } from "../constants.js";
import { runGit } from "./executor.js";

export async function getBlameForLine(
  repoPath: string,
  filePath: string,
  lineNumber: number,
): Promise<string | null> {
  try {
    const output = await runGit(repoPath, [
      "blame",
      "-L",
      `${lineNumber},${lineNumber}`,
      "--porcelain",
      "--",
      filePath,
    ]);

    const commitSha = output.split(" ")[0];
    if (!commitSha || commitSha === NULL_COMMIT_SHA) {
      return null;
    }

    return commitSha;
  } catch {
    return null;
  }
}
