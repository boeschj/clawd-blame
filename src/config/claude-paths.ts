import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as vscode from "vscode";

import { CONFIG_KEYS } from "../constants.js";

export function findClaudeConfigDir(): string | null {
  const configSetting = vscode.workspace
    .getConfiguration()
    .get<string>(CONFIG_KEYS.ClaudeConfigPath);

  if (configSetting && configSetting.length > 0) {
    return configSetting;
  }

  const envPath = process.env["CLAUDE_CONFIG_DIR"];
  if (envPath && envPath.length > 0) {
    return envPath;
  }

  const defaultPath = path.join(os.homedir(), ".claude");
  if (fs.existsSync(defaultPath)) {
    return defaultPath;
  }

  return null;
}

export function getProjectSessionsDir(
  claudeConfigDir: string,
  projectPath: string,
): string {
  const encodedProjectPath = projectPath.replace(/[\\/]/g, "-");
  return path.join(claudeConfigDir, "projects", encodedProjectPath);
}
