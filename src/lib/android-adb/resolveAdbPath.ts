import { existsSync } from "fs";
import * as path from "path";

const androidAdbPathEnv = "ANDROID_ADB_PATH";
const adbExecutableName = "adb.exe";

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
  return message.startsWith(`${androidAdbPathEnv} is set but`);
}

export function resolveAdbPath(): string {
  const envPath = process.env[androidAdbPathEnv]?.trim();
  if (envPath) {
    const adbPath = stripOuterQuotes(envPath);
    if (!existsSync(adbPath)) {
      throw new Error(
        `${androidAdbPathEnv} is set but adb executable was not found: ${adbPath}`,
      );
    }
    return adbPath;
  }

  const resourcesPath = electronResourcesPath();
  if (resourcesPath) {
    const bundledAdbPath = path.join(
      resourcesPath,
      "platform-tools",
      adbExecutableName,
    );
    if (existsSync(bundledAdbPath)) {
      return bundledAdbPath;
    }
  }

  return "adb";
}
