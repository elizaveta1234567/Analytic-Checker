import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as readline from "readline";
import { adbPath, packageName } from "./adbConfig";
import { normalizeAdbLogLine } from "./logParser";
import { streamState } from "./streamState";

const globalAny = globalThis as any;

if (!globalAny.__adbManager) {
  let logcatChild: ChildProcessWithoutNullStreams | null = null;
  let logcatReadline: readline.Interface | null = null;
  let startInFlight = false;

  function getPidOf(effectivePackageName: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        adbPath,
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

        const child = spawn(adbPath, ["logcat", `--pid=${pid}`], {
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
}

export const adbManager = globalAny.__adbManager;
