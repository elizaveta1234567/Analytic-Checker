import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as readline from "readline";
import { idevicesyslogPath, udid } from "./iosConfig";
import { normalizeIosLogLine } from "./logParser";
import { streamState } from "./streamState";

const globalAny = globalThis as any;

if (!globalAny.__iosManager) {
  let syslogChild: ChildProcessWithoutNullStreams | null = null;
  let syslogReadline: readline.Interface | null = null;
  let startInFlight = false;

  // TEMP iOS raw syslog diagnostics: log only "possibly useful" lines.
  // Goal: verify whether analytics is printed to syslog at all.
  const RAW_DEBUG_MARKERS = [
    "paper",
    "appmetrica",
    "analytic",
    "event",
    "subscription",
    "tracking",
    "gift",
    "room",
    "click",
    "impression",
  ] as const;

  function shouldLogRawDebug(rawLine: string): boolean {
    const l = rawLine.toLowerCase();
    return RAW_DEBUG_MARKERS.some((m) => l.includes(m));
  }

  // Minimal multi-line analytics buffering:
  // idevicesyslog can split one analytics message across a few lines.
  // If we see a "Client event ... funnel." stub, we join up to the next 3 lines.
  let pendingAnalyticsBlock:
    | { kind: "received" | "saved"; lines: string[]; remaining: number }
    | null = null;

  function funnelStubKind(rawLine: string): "received" | "saved" | null {
    if (rawLine.includes("Client event is received: funnel.")) return "received";
    if (rawLine.includes("Client event is saved to db: funnel.")) return "saved";
    return null;
  }

  function flushPendingBlock(): void {
    if (!pendingAnalyticsBlock) return;
    const joined = pendingAnalyticsBlock.lines.join("\n");
    const kind = pendingAnalyticsBlock.kind;
    pendingAnalyticsBlock = null;
    // Rule: blocks started from "saved to db" must never reach stream/matcher.
    if (kind === "saved") return;
    const normalized = normalizeIosLogLine(joined);
    if (normalized !== null) {
      streamState.addLog(normalized);
    }
  }

  function teardownSyslog(reason: "stop" | "exit") {
    if (reason === "stop") {
      syslogChild?.kill();
    }
    syslogReadline?.close();
    syslogReadline = null;
    syslogChild = null;
    streamState.setRunning(false);
  }

  globalAny.__iosManager = {
    async start(): Promise<void> {
      if (syslogChild !== null || startInFlight) {
        return;
      }
      startInFlight = true;
      try {
        streamState.clear();

        const args: string[] = [];
        if (udid) {
          args.push("-u", udid);
        }

        const child = spawn(idevicesyslogPath, args, {
          stdio: ["ignore", "pipe", "pipe"],
        });

        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          console.error("[iosManager][stderr]", String(chunk));
        });

        child.on("error", (err) => {
          console.error("[iosManager] idevicesyslog error", err);
          teardownSyslog("exit");
        });

        child.on("close", () => {
          console.log("[iosManager] idevicesyslog closed");
          if (syslogChild === child) {
            teardownSyslog("exit");
          }
        });

        const rl = readline.createInterface({
          input: child.stdout,
          crlfDelay: Infinity,
        });

        rl.on("line", (rawLine) => {
          if (shouldLogRawDebug(rawLine)) {
            console.log("[ios-raw-debug]", rawLine);
          }

          // If a multi-line block is pending, collect this line and flush when ready.
          if (pendingAnalyticsBlock) {
            pendingAnalyticsBlock.lines.push(rawLine);
            pendingAnalyticsBlock.remaining -= 1;
            // Flush early if we already saw an explicit marker; otherwise after 1–3 lines.
            if (
              rawLine.includes("Analytic report:") ||
              /\bfunnel\.[A-Za-z0-9_]+\./.test(rawLine) ||
              pendingAnalyticsBlock.remaining <= 0
            ) {
              flushPendingBlock();
            }
            return;
          }

          // Start buffering when we see a funnel stub line.
          const kind = funnelStubKind(rawLine);
          if (kind) {
            pendingAnalyticsBlock = { kind, lines: [rawLine], remaining: 3 };
            return;
          }

          const normalized = normalizeIosLogLine(rawLine);
          if (normalized !== null) {
            streamState.addLog(normalized);
          }
        });

        syslogChild = child;
        syslogReadline = rl;
        streamState.setRunning(true);
      } finally {
        startInFlight = false;
      }
    },

    stop(): void {
      teardownSyslog("stop");
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

export const iosManager = globalAny.__iosManager;

