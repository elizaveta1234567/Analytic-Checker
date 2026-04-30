import { promises as fs } from "fs";
import {
  defaultUnityEditorLogPath,
  maxReadChunkBytes,
  pollIntervalMs,
} from "./unityConfig";
import { normalizeUnityLogLine } from "./logParser";
import { streamState, type UnityLiveStatus } from "./streamState";

type UnityLogListener = (line: string) => void;

type UnityManager = {
  start(logPathOverride?: string): Promise<void>;
  stop(): void;
  clear(): void;
  isRunning(): boolean;
  getStatus(): UnityLiveStatus;
  getActiveLogPath(): string | null;
  getBufferedLogs(): string[];
  subscribe(listener: UnityLogListener): void;
  unsubscribe(listener: UnityLogListener): void;
};

const globalAny = globalThis as typeof globalThis & {
  __unityManager?: UnityManager;
};

if (!globalAny.__unityManager) {
  let watchTimer: ReturnType<typeof setInterval> | null = null;
  let startInFlight = false;
  let activeLogPath: string | null = null;
  let offset = 0;
  let partialLine = "";
  let readInFlight = false;
  let resetOffsetToEnd = false;

  function resolveLogPath(logPathOverride?: string): string {
    return logPathOverride?.trim() || defaultUnityEditorLogPath;
  }

  function processChunk(chunk: string) {
    const normalizedText = (partialLine + chunk)
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
    const endsWithNewLine = normalizedText.endsWith("\n");
    const lines = normalizedText.split("\n");

    partialLine = endsWithNewLine ? "" : lines.pop() ?? "";

    for (const rawLine of lines) {
      const normalized = normalizeUnityLogLine(rawLine);
      if (normalized === null) {
        continue;
      }
      streamState.addLog(normalized);
    }
  }

  async function readRange(
    filePath: string,
    start: number,
    byteLength: number,
  ): Promise<string> {
    const fileHandle = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(byteLength);
      const { bytesRead } = await fileHandle.read(
        buffer,
        0,
        byteLength,
        start,
      );
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await fileHandle.close();
    }
  }

  async function readAppendedChunks() {
    if (activeLogPath === null || readInFlight) {
      return;
    }

    readInFlight = true;
    try {
      const stats = await fs.stat(activeLogPath);
      if (!stats.isFile()) {
        throw new Error(`Unity Editor log is not a file: ${activeLogPath}`);
      }

      if (resetOffsetToEnd || stats.size < offset) {
        offset = stats.size;
        partialLine = "";
        resetOffsetToEnd = false;
        streamState.setStatus("live");
        return;
      }

      if (stats.size === offset) {
        return;
      }

      let readStart = offset;
      let byteLength = stats.size - offset;
      if (byteLength > maxReadChunkBytes) {
        readStart = stats.size - maxReadChunkBytes;
        byteLength = maxReadChunkBytes;
        partialLine = "";
        console.warn(
          "[unityManager] large Editor.log append detected; reading last chunk only",
        );
      }

      const chunk = await readRange(activeLogPath, readStart, byteLength);
      offset = stats.size;
      processChunk(chunk);
      streamState.setStatus("live");
    } catch (error) {
      resetOffsetToEnd = true;
      streamState.setStatus("connecting");
      console.error("[unityManager] failed to read Unity Editor log", error);
    } finally {
      readInFlight = false;
    }
  }

  function teardown() {
    if (watchTimer !== null) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
    activeLogPath = null;
    offset = 0;
    partialLine = "";
    readInFlight = false;
    resetOffsetToEnd = false;
    streamState.setStatus("disconnected");
    streamState.setActiveLogPath(null);
  }

  globalAny.__unityManager = {
    async start(logPathOverride?: string): Promise<void> {
      if (watchTimer !== null || startInFlight) {
        return;
      }

      startInFlight = true;
      const effectiveLogPath = resolveLogPath(logPathOverride);
      streamState.setStatus("connecting");
      streamState.setActiveLogPath(effectiveLogPath);

      try {
        const stats = await fs.stat(effectiveLogPath);
        if (!stats.isFile()) {
          throw new Error(`Unity Editor log is not a file: ${effectiveLogPath}`);
        }

        activeLogPath = effectiveLogPath;
        offset = stats.size;
        partialLine = "";
        resetOffsetToEnd = false;
        streamState.clear();
        watchTimer = setInterval(() => {
          void readAppendedChunks();
        }, pollIntervalMs);
        streamState.setStatus("live");
      } catch (error) {
        teardown();
        throw error;
      } finally {
        startInFlight = false;
      }
    },

    stop(): void {
      teardown();
    },

    clear(): void {
      streamState.clear();
    },

    isRunning(): boolean {
      return streamState.getStatus() === "live";
    },

    getStatus(): UnityLiveStatus {
      return streamState.getStatus();
    },

    getActiveLogPath(): string | null {
      return streamState.getActiveLogPath();
    },

    getBufferedLogs(): string[] {
      return streamState.getSnapshot();
    },

    subscribe(listener: UnityLogListener): void {
      streamState.subscribe(listener);
    },

    unsubscribe(listener: UnityLogListener): void {
      streamState.unsubscribe(listener);
    },
  };
}

export const unityManager = globalAny.__unityManager as UnityManager;
