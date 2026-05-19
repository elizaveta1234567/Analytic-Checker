import { maxBufferedLogs } from "./unityConfig";

export type UnityLiveStatus = "disconnected" | "connecting" | "live";

export type UnityLogSourceType = "editor" | "player" | "custom";
export type UnityTailMode = "watcher" | "polling" | "both";
export type UnityExtractedAnalyticsType = "AppsFlyer" | "AppMetrica" | "ABTest";

export type UnityLiveDebugInfo = {
  resolvedLogPath: string | null;
  logFileName: string | null;
  logSourceType: UnityLogSourceType;
  detectedProjectPath: string | null;
  detectedProductName: string | null;
  logFileExists: boolean | null;
  watcherStarted: boolean;
  lastError: string | null;
  lastLineAt: number | null;
  analyticsEventsSeenCount: number;
  rawLinesSeenCount: number;
  analyticsCandidateLinesCount: number;
  lastRawLineAt: number | null;
  initialTailRead: boolean;
  initialTailLinesCount: number;
  lastRawLine: string | null;
  lastExtractedEvent: string | null;
  lastExtractedAnalyticsType: UnityExtractedAnalyticsType | null;
  tailMode: UnityTailMode;
};

export type UnityLogStreamEntry = {
  rawLine: string;
  analyticsLine: string | null;
  timestamp: number;
  extractedEvent?: string | null;
  analyticsType?: UnityExtractedAnalyticsType | null;
  detectedProjectPath?: string | null;
  detectedProductName?: string | null;
};

let status: UnityLiveStatus = "disconnected";
let activeLogPath: string | null = null;
let logFileName: string | null = null;
let logSourceType: UnityLogSourceType = "custom";
let detectedProjectPath: string | null = null;
let detectedProductName: string | null = null;
let logFileExists: boolean | null = null;
let watcherStarted = false;
let lastError: string | null = null;
let lastLineAt: number | null = null;
let lastRawLineAt: number | null = null;
let initialTailRead = false;
let initialTailLinesCount = 0;
let lastRawLine: string | null = null;
let lastExtractedEvent: string | null = null;
let lastExtractedAnalyticsType: UnityExtractedAnalyticsType | null = null;
let tailMode: UnityTailMode = "polling";
let analyticsEventsSeenCount = 0;
let rawLinesSeenCount = 0;
let analyticsCandidateLinesCount = 0;
const lastLogs: UnityLogStreamEntry[] = [];
const listeners = new Set<(entry: UnityLogStreamEntry) => void>();

export const streamState = {
  setStatus(value: UnityLiveStatus) {
    status = value;
  },

  getStatus(): UnityLiveStatus {
    return status;
  },

  setActiveLogPath(value: string | null) {
    activeLogPath = value;
  },

  getActiveLogPath(): string | null {
    return activeLogPath;
  },

  setLogFileInfo(params: {
    fileName: string | null;
    sourceType: UnityLogSourceType;
    detectedProductName?: string | null;
  }) {
    logFileName = params.fileName;
    logSourceType = params.sourceType;
    if (params.detectedProductName !== undefined) {
      detectedProductName = params.detectedProductName;
    }
  },

  setDetectedProjectPath(value: string | null) {
    detectedProjectPath = value;
  },

  setDetectedProductName(value: string | null) {
    detectedProductName = value;
  },

  setLogFileExists(value: boolean | null) {
    logFileExists = value;
  },

  setWatcherStarted(value: boolean) {
    watcherStarted = value;
  },

  setLastError(value: string | null) {
    lastError = value;
  },

  setInitialTailResult(value: { read: boolean; linesCount: number }) {
    initialTailRead = value.read;
    initialTailLinesCount = value.linesCount;
  },

  setTailMode(value: UnityTailMode) {
    tailMode = value;
  },

  addLog(entry: Omit<UnityLogStreamEntry, "timestamp"> & { timestamp?: number }) {
    const timestamp = entry.timestamp ?? Date.now();
    const nextEntry: UnityLogStreamEntry = {
      rawLine: entry.rawLine,
      analyticsLine: entry.analyticsLine,
      timestamp,
      extractedEvent: entry.extractedEvent,
      analyticsType: entry.analyticsType,
      detectedProjectPath: entry.detectedProjectPath,
      detectedProductName: entry.detectedProductName,
    };
    lastLogs.push(nextEntry);
    lastLineAt = timestamp;
    lastRawLineAt = timestamp;
    lastRawLine = entry.rawLine;
    rawLinesSeenCount += 1;
    if (entry.analyticsLine !== null) {
      analyticsEventsSeenCount += 1;
      analyticsCandidateLinesCount += 1;
      lastExtractedEvent = entry.extractedEvent ?? null;
      lastExtractedAnalyticsType = entry.analyticsType ?? null;
    }
    while (lastLogs.length > maxBufferedLogs) {
      lastLogs.shift();
    }
    for (const listener of listeners) {
      listener(nextEntry);
    }
  },

  subscribe(listener: (entry: UnityLogStreamEntry) => void) {
    listeners.add(listener);
  },

  unsubscribe(listener: (entry: UnityLogStreamEntry) => void) {
    listeners.delete(listener);
  },

  clear() {
    lastLogs.length = 0;
  },

  getSnapshot(): UnityLogStreamEntry[] {
    return [...lastLogs];
  },

  resetDebug() {
    logFileExists = null;
    watcherStarted = false;
    lastError = null;
    lastLineAt = null;
    lastRawLineAt = null;
    logFileName = null;
    logSourceType = "custom";
    detectedProjectPath = null;
    detectedProductName = null;
    initialTailRead = false;
    initialTailLinesCount = 0;
    lastRawLine = null;
    lastExtractedEvent = null;
    lastExtractedAnalyticsType = null;
    tailMode = "polling";
    analyticsEventsSeenCount = 0;
    rawLinesSeenCount = 0;
    analyticsCandidateLinesCount = 0;
  },

  getDebugInfo(): UnityLiveDebugInfo {
    return {
      resolvedLogPath: activeLogPath,
      logFileName,
      logSourceType,
      detectedProjectPath,
      detectedProductName,
      logFileExists,
      watcherStarted,
      lastError,
      lastLineAt,
      analyticsEventsSeenCount,
      rawLinesSeenCount,
      analyticsCandidateLinesCount,
      lastRawLineAt,
      initialTailRead,
      initialTailLinesCount,
      lastRawLine,
      lastExtractedEvent,
      lastExtractedAnalyticsType,
      tailMode,
    };
  },
};
