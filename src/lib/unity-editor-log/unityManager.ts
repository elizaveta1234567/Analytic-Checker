import { promises as fs } from "fs";
import path from "path";
import {
  defaultUnityEditorLogPath,
  maxReadChunkBytes,
  pollIntervalMs,
} from "./unityConfig";
import {
  normalizeUnityRawLogLine,
  parseUnityAnalyticsLogLine,
} from "./logParser";
import {
  streamState,
  type UnityLiveDebugInfo,
  type UnityLogStreamEntry,
  type UnityLogSourceType,
  type UnityLiveStatus,
} from "./streamState";

type UnityLogListener = (entry: UnityLogStreamEntry) => void;

const initialTailLineLimit = 100;

type UnityManager = {
  start(logPathOverride?: string): Promise<void>;
  stop(): void;
  clear(): void;
  isRunning(): boolean;
  getStatus(): UnityLiveStatus;
  getActiveLogPath(): string | null;
  getDebugInfo(): UnityLiveDebugInfo;
  getBufferedLogs(): UnityLogStreamEntry[];
  subscribe(listener: UnityLogListener): void;
  unsubscribe(listener: UnityLogListener): void;
};

class UnityEditorLogError extends Error {
  errorCode:
    | "UNITY_EDITOR_LOG_NOT_FOUND"
    | "UNITY_EDITOR_LOG_ACCESS_DENIED"
    | "UNITY_EDITOR_LOG_PATH_IS_DIRECTORY";

  constructor(
    errorCode: UnityEditorLogError["errorCode"],
    message: string,
  ) {
    super(message);
    this.name = "UnityEditorLogError";
    this.errorCode = errorCode;
  }
}

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

  function expandWindowsEnvVariables(value: string): string {
    return value.replace(/%([^%]+)%/g, (match, envName) => {
      const envValue = process.env[envName];
      return envValue && envValue.trim() ? envValue : match;
    });
  }

  function resolveLogPath(logPathOverride?: string): string {
    const rawPath = logPathOverride?.trim() || defaultUnityEditorLogPath;
    const expandedPath = expandWindowsEnvVariables(rawPath);
    if (expandedPath.startsWith("~")) {
      return path.resolve(
        path.join(process.env.USERPROFILE || process.env.HOME || "", expandedPath.slice(1)),
      );
    }
    return path.resolve(expandedPath);
  }

  function looksLikeUnityEditorDirectory(filePath: string): boolean {
    const normalizedParts = path
      .normalize(filePath)
      .split(path.sep)
      .map((part) => part.toLowerCase());
    return (
      normalizedParts[normalizedParts.length - 1] === "editor" &&
      normalizedParts.includes("unity")
    );
  }

  function looksLikeUnityPlayerDirectory(filePath: string): boolean {
    const normalizedParts = path
      .normalize(filePath)
      .split(path.sep)
      .map((part) => part.toLowerCase());
    const localLowIndex = normalizedParts.indexOf("locallow");
    return localLowIndex !== -1 && normalizedParts.length >= localLowIndex + 3;
  }

  function getUnityLogSourceType(filePath: string): UnityLogSourceType {
    const fileName = path.basename(filePath).toLowerCase();
    if (fileName === "editor.log") {
      return "editor";
    }
    if (fileName === "player.log") {
      return "player";
    }
    return "custom";
  }

  function getPlayerProductNameFromPath(filePath: string): string | null {
    if (getUnityLogSourceType(filePath) !== "player") {
      return null;
    }
    const productName = path.basename(path.dirname(filePath)).trim();
    return productName || null;
  }

  function getAccessDeniedMessage(filePath: string): string {
    return `Access denied while reading Unity Editor.log / Player.log: ${filePath}`;
  }

  function cleanDetectedLogValue(value: string): string | null {
    const cleaned = value
      .trim()
      .replace(/^["']|["']$/g, "")
      .replace(/\s+\(.*\)$/g, "")
      .trim();
    return cleaned || null;
  }

  function extractEditorProjectPath(line: string): string | null {
    const projectPathMatch =
      /(?:^|\b)(?:project path|projectpath|initial project path|loading project from)\s*[:=]\s*(.+)$/i.exec(
        line,
      ) ??
      /(?:^|\s)-projectPath\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(line);
    const rawValue =
      projectPathMatch?.[1] ?? projectPathMatch?.[2] ?? projectPathMatch?.[3];
    if (!rawValue) {
      return null;
    }
    const cleaned = cleanDetectedLogValue(rawValue);
    if (!cleaned) {
      return null;
    }
    return /[\\/]+assets$/i.test(cleaned) ? path.dirname(cleaned) : cleaned;
  }

  function extractUnityProductName(line: string): string | null {
    const productNameMatch =
      /(?:^|\b)(?:product name|productname|application\.productname)\s*[:=]\s*(.+)$/i.exec(
        line,
      );
    return productNameMatch?.[1]
      ? cleanDetectedLogValue(productNameMatch[1])
      : null;
  }

  function collectDetectedMetadata(line: string): {
    detectedProjectPath?: string;
    detectedProductName?: string;
  } {
    const detectedProjectPath = extractEditorProjectPath(line) ?? undefined;
    const detectedProductName = extractUnityProductName(line) ?? undefined;
    if (detectedProjectPath) {
      streamState.setDetectedProjectPath(detectedProjectPath);
    }
    if (detectedProductName) {
      streamState.setDetectedProductName(detectedProductName);
    }
    return {
      detectedProjectPath,
      detectedProductName,
    };
  }

  async function statUnityLogFile(
    filePath: string,
  ): Promise<{ resolvedPath: string; size: number }> {
    let resolvedPath = filePath;
    const initialBaseName = path.basename(resolvedPath).toLowerCase();
    if (looksLikeUnityEditorDirectory(resolvedPath)) {
      resolvedPath = path.join(resolvedPath, "Editor.log");
    } else if (
      initialBaseName !== "player.log" &&
      looksLikeUnityPlayerDirectory(resolvedPath)
    ) {
      resolvedPath = path.join(resolvedPath, "Player.log");
    }

    try {
      let stats = await fs.stat(resolvedPath);
      if (stats.isDirectory()) {
        if (looksLikeUnityEditorDirectory(resolvedPath)) {
          resolvedPath = path.join(resolvedPath, "Editor.log");
          stats = await fs.stat(resolvedPath);
        } else if (looksLikeUnityPlayerDirectory(resolvedPath)) {
          resolvedPath = path.join(resolvedPath, "Player.log");
          stats = await fs.stat(resolvedPath);
        } else {
          throw new UnityEditorLogError(
            "UNITY_EDITOR_LOG_PATH_IS_DIRECTORY",
            "Please provide full path to Editor.log / Player.log",
          );
        }
      }
      if (!stats.isFile()) {
        throw new UnityEditorLogError(
          "UNITY_EDITOR_LOG_PATH_IS_DIRECTORY",
          `Unity Editor.log / Player.log is not a file: ${resolvedPath}`,
        );
      }
      streamState.setLogFileExists(true);
      return { resolvedPath, size: stats.size };
    } catch (error) {
      const code =
        typeof (error as { code?: unknown } | null)?.code === "string"
          ? (error as { code: string }).code
          : "";
      if (error instanceof UnityEditorLogError) {
        streamState.setLogFileExists(false);
        throw error;
      }
      if (code === "ENOENT") {
        streamState.setLogFileExists(false);
        throw new UnityEditorLogError(
          "UNITY_EDITOR_LOG_NOT_FOUND",
          "Unity Editor.log / Player.log was not found. Start Unity or provide the full path to Editor.log / Player.log.",
        );
      }
      if (code === "EACCES" || code === "EPERM") {
        streamState.setLogFileExists(true);
        throw new UnityEditorLogError(
          "UNITY_EDITOR_LOG_ACCESS_DENIED",
          getAccessDeniedMessage(resolvedPath),
        );
      }
      streamState.setLogFileExists(null);
      throw error;
    }
  }

  function processLogLine(rawLine: string): boolean {
    const normalizedRawLine = normalizeUnityRawLogLine(rawLine);
    if (normalizedRawLine === null) {
      return false;
    }
    const analytics = parseUnityAnalyticsLogLine(rawLine);
    const detectedMetadata = collectDetectedMetadata(normalizedRawLine);
    console.log(`[unityLive] line=${normalizedRawLine}`);
    streamState.addLog({
      rawLine: normalizedRawLine,
      analyticsLine: analytics?.analyticsLine ?? null,
      extractedEvent: analytics?.extractedEvent ?? null,
      analyticsType: analytics?.analyticsType ?? null,
      detectedProjectPath: detectedMetadata.detectedProjectPath,
      detectedProductName: detectedMetadata.detectedProductName,
    });
    return true;
  }

  function processChunk(chunk: string) {
    const normalizedText = (partialLine + chunk)
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
    const endsWithNewLine = normalizedText.endsWith("\n");
    const lines = normalizedText.split("\n");

    partialLine = endsWithNewLine ? "" : lines.pop() ?? "";

    for (const rawLine of lines) {
      processLogLine(rawLine);
    }
  }

  async function readInitialTail(filePath: string, fileSize: number): Promise<number> {
    if (fileSize <= 0) {
      streamState.setInitialTailResult({ read: true, linesCount: 0 });
      return 0;
    }

    const byteLength = Math.min(fileSize, maxReadChunkBytes);
    const readStart = Math.max(0, fileSize - byteLength);
    const chunk = await readRange(filePath, readStart, byteLength);
    const normalizedText = chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = normalizedText.split("\n");
    if (readStart > 0) {
      lines.shift();
    }
    if (normalizedText.endsWith("\n")) {
      lines.pop();
    }

    let processedCount = 0;
    for (const rawLine of lines.slice(-initialTailLineLimit)) {
      if (processLogLine(rawLine)) {
        processedCount += 1;
      }
    }
    streamState.setInitialTailResult({
      read: true,
      linesCount: processedCount,
    });
    return processedCount;
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
      streamState.setStatus("disconnected");
      streamState.setWatcherStarted(false);
      const message = error instanceof Error ? error.message : String(error);
      streamState.setLastError(message);
      console.error(`[unityLive] error=${message}`);
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
    streamState.setWatcherStarted(false);
  }

  globalAny.__unityManager = {
    async start(logPathOverride?: string): Promise<void> {
      if (watchTimer !== null || startInFlight) {
        return;
      }

      startInFlight = true;
      const effectiveLogPath = resolveLogPath(logPathOverride);
      console.log(`[unityLive] connectStart path=${logPathOverride?.trim() || defaultUnityEditorLogPath}`);
      console.log(`[unityLive] resolvedPath=${effectiveLogPath}`);
      streamState.setStatus("connecting");
      streamState.setActiveLogPath(effectiveLogPath);
      streamState.resetDebug();
      streamState.setActiveLogPath(effectiveLogPath);

      try {
        const resolvedLog = await statUnityLogFile(effectiveLogPath);
        console.log("[unityLive] fileExists=true");

        activeLogPath = resolvedLog.resolvedPath;
        streamState.setActiveLogPath(resolvedLog.resolvedPath);
        streamState.setLogFileInfo({
          fileName: path.basename(resolvedLog.resolvedPath),
          sourceType: getUnityLogSourceType(resolvedLog.resolvedPath),
          detectedProductName: getPlayerProductNameFromPath(
            resolvedLog.resolvedPath,
          ),
        });
        offset = resolvedLog.size;
        partialLine = "";
        resetOffsetToEnd = false;
        streamState.clear();
        const initialTailLinesCount = await readInitialTail(
          activeLogPath,
          resolvedLog.size,
        );
        console.log(
          `[unityLive] initialTailRead=true initialTailLinesCount=${initialTailLinesCount}`,
        );
        watchTimer = setInterval(() => {
          void readAppendedChunks();
        }, pollIntervalMs);
        streamState.setTailMode("polling");
        streamState.setWatcherStarted(true);
        console.log("[unityLive] watcherStarted=true");
        streamState.setStatus("live");
        streamState.setLastError(null);
        console.log("[unityLive] connected");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(
          `[unityLive] fileExists=${streamState.getDebugInfo().logFileExists === true}`,
        );
        console.log("[unityLive] watcherStarted=false");
        console.error(`[unityLive] error=${message}`);
        streamState.setLastError(message);
        streamState.setWatcherStarted(false);
        teardown();
        streamState.setActiveLogPath(effectiveLogPath);
        streamState.setLastError(message);
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

    getDebugInfo(): UnityLiveDebugInfo {
      return streamState.getDebugInfo();
    },

    getBufferedLogs(): UnityLogStreamEntry[] {
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
