import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as readline from "readline";
import { packageName } from "./adbConfig";
import { normalizeAdbLogLine } from "./logParser";
import { isAdbPathResolutionError, resolveAdbPath } from "./resolveAdbPath";
import { streamState } from "./streamState";

const globalAny = globalThis as any;

const foregroundPackageDetectionFailedMessage =
  "Could not detect foreground Android package. Make sure the app is open on device.";

type ForegroundPackageDetectionCommand = {
  label: string;
  args: readonly string[];
  parseAllLines?: boolean;
};

const foregroundPackageDetectionCommands: ForegroundPackageDetectionCommand[] = [
  {
    label: "adb shell cmd activity get-foreground-activity",
    args: ["shell", "cmd", "activity", "get-foreground-activity"],
    parseAllLines: true,
  },
  {
    label: "adb shell dumpsys window",
    args: ["shell", "dumpsys", "window"],
  },
  {
    label: "adb shell dumpsys activity activities",
    args: ["shell", "dumpsys", "activity", "activities"],
  },
  {
    label: "adb shell dumpsys activity top",
    args: ["shell", "dumpsys", "activity", "top"],
  },
];

function isAdbDeviceError(message: string): boolean {
  return /no devices?\/emulators found|\bno devices?\b|\bdevice offline\b|\bdevice ['"][^'"]+['"] not found\b|\bdevice not found\b|\bunauthorized\b|\bmore than one device\b|\bfailed to get feature set\b|\binsufficient permissions\b|\bno permissions\b/i.test(
    message,
  );
}

function runAdbCommand(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveAdbPath(), [...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `ADB command failed: ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function parseForegroundPackageName(
  adbOutput: string,
  parseAllLines = false,
): string | null {
  const packagePattern = /\b([a-zA-Z][\w]*(?:\.[\w]+)+)\/[^\s)}]+/;
  const foregroundMarkers = [
    "mCurrentFocus",
    "topResumedActivity",
    "mResumedActivity",
    "ResumedActivity",
    "mFocusedApp",
    "mFocusedActivity",
    "ACTIVITY ",
  ];

  for (const line of adbOutput.split(/\r?\n/)) {
    if (
      !parseAllLines &&
      !foregroundMarkers.some((marker) => line.includes(marker))
    ) {
      continue;
    }

    const cmpMatch = line.match(
      /\bcmp=([a-zA-Z][\w]*(?:\.[\w]+)+)\/[^\s}]+/,
    );
    if (cmpMatch?.[1]) {
      return cmpMatch[1];
    }

    const match = line.match(packagePattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

async function detectForegroundPackageName(): Promise<string> {
  for (const command of foregroundPackageDetectionCommands) {
    try {
      const output = await runAdbCommand(command.args);
      const foregroundPackageName = parseForegroundPackageName(
        output,
        command.parseAllLines ?? false,
      );
      if (foregroundPackageName) {
        return foregroundPackageName;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (isAdbPathResolutionError(message) || isAdbDeviceError(message)) {
        throw new Error(message);
      }
      console.warn(`[adbManager] ${command.label} failed`, e);
    }
  }

  throw new Error(foregroundPackageDetectionFailedMessage);
}

if (!globalAny.__adbManager) {
  let logcatChild: ChildProcessWithoutNullStreams | null = null;
  let logcatReadline: readline.Interface | null = null;
  let startInFlight = false;

  function getPidOf(effectivePackageName: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        resolveAdbPath(),
        ["shell", "pidof", "-s", effectivePackageName],
        {
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        console.error(chunk);
      });
      child.on("error", reject);
      child.on("close", () => {
        resolve(stdout.trim());
      });
    });
  }

  function teardownLogcat(reason: "stop" | "exit") {
    if (reason === "stop") {
      logcatChild?.kill();
    }
    logcatReadline?.close();
    logcatReadline = null;
    logcatChild = null;
    streamState.setRunning(false);
  }

  globalAny.__adbManager = {
    detectForegroundPackageName,

    async start(packageNameOverride?: string): Promise<void> {
      if (logcatChild !== null || startInFlight) {
        return;
      }
      startInFlight = true;
      try {
        const effectivePackageName = packageNameOverride?.trim() || packageName;
        const pid = await getPidOf(effectivePackageName);
        if (!pid) {
          throw new Error("App process not found");
        }

        console.log("[adbManager] pid:", pid);
        console.log("[adbManager] starting logcat for pid", pid);

        const child = spawn(resolveAdbPath(), ["logcat", `--pid=${pid}`], {
          stdio: ["ignore", "pipe", "pipe"],
        });

        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          console.error("[adbManager][stderr]", String(chunk));
        });

        child.on("error", (err) => {
          console.error("[adbManager] logcat error", err);
          teardownLogcat("exit");
        });

        child.on("close", () => {
          console.log("[adbManager] logcat closed");
          if (logcatChild === child) {
            teardownLogcat("exit");
          }
        });

        const rl = readline.createInterface({
          input: child.stdout,
          crlfDelay: Infinity,
        });

        rl.on("line", (rawLine) => {
          const normalized = normalizeAdbLogLine(rawLine);
          if (normalized === null) {
            return;
          }
          console.log("[adbManager] accepted analytics line");
          streamState.addLog(normalized);
        });

        logcatChild = child;
        logcatReadline = rl;
        streamState.setRunning(true);
      } finally {
        startInFlight = false;
      }
    },

    stop(): void {
      teardownLogcat("stop");
    },

    isRunning(): boolean {
      return streamState.isRunning();
    },

    getBufferedLogs(): string[] {
      return streamState.getSnapshot();
    },

    subscribe(listener: (line: string) => void): void {
      streamState.subscribe(listener);
    },

    unsubscribe(listener: (line: string) => void): void {
      streamState.unsubscribe(listener);
    },
  };
} else {
  globalAny.__adbManager.detectForegroundPackageName =
    detectForegroundPackageName;
}

export const adbManager = globalAny.__adbManager;
