import { existsSync } from "fs";
import * as path from "path";

const adbPathEnv = "ADB_PATH";
const adbExecutableName = process.platform === "win32" ? "adb.exe" : "adb";
const adbNotFoundMessage =
  "adb.exe was not found. Expected it in ./platform-tools/adb.exe or resources/platform-tools/adb.exe";

function stripOuterQuotes(value: string): string {
  return value.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
}

function electronResourcesPath(): string | null {
  const electronProcess = process as NodeJS.Process & {
    resourcesPath?: string;
  };
  const resourcesPath = electronProcess.resourcesPath?.trim();
  return resourcesPath ? resourcesPath : null;
}

export function isAdbPathResolutionError(message: string): boolean {
  return message.startsWith(adbNotFoundMessage);
}

function resolveAdbFromPath(checkedPaths: string[]): string | null {
  const pathValue = process.env.PATH ?? process.env.Path ?? "";
  if (!pathValue.trim()) {
    checkedPaths.push("PATH=<empty>");
    return null;
  }

  for (const rawDirectory of pathValue.split(path.delimiter)) {
    const directory = stripOuterQuotes(rawDirectory.trim());
    if (!directory) {
      continue;
    }

    const adbPath = path.join(directory, adbExecutableName);
    checkedPaths.push(`PATH=${adbPath}`);
    if (existsSync(adbPath)) {
      return adbPath;
    }
  }

  return null;
}

function buildAdbNotFoundError(checkedPaths: string[]): Error {
  return new Error(
    `${adbNotFoundMessage}. Checked paths: ${checkedPaths.join("; ")}`,
  );
}

export function resolveAdbPath(): string {
  const checkedPaths: string[] = [];
  const envPath = process.env[adbPathEnv]?.trim();
  if (envPath) {
    const adbPath = stripOuterQuotes(envPath);
    checkedPaths.push(`${adbPathEnv}=${adbPath}`);
    if (existsSync(adbPath)) {
      return adbPath;
    }
  } else {
    checkedPaths.push(`${adbPathEnv}=<not set>`);
  }

  const resourcesPath = electronResourcesPath();
  let resourcesAdbPath: string | null = null;
  if (resourcesPath) {
    resourcesAdbPath = path.join(
      resourcesPath,
      "platform-tools",
      adbExecutableName,
    );
    checkedPaths.push(`resources=${resourcesAdbPath}`);
    if (existsSync(resourcesAdbPath)) {
      return resourcesAdbPath;
    }
  } else {
    checkedPaths.push("resources=<not available>");
  }

  const devAdbPath = path.join(
    process.cwd(),
    "platform-tools",
    adbExecutableName,
  );
  checkedPaths.push(`dev=${devAdbPath}`);
  if (existsSync(devAdbPath)) {
    return devAdbPath;
  }

  const pathAdbPath = resolveAdbFromPath(checkedPaths);
  if (pathAdbPath) {
    return pathAdbPath;
  }

  throw buildAdbNotFoundError(checkedPaths);
}
