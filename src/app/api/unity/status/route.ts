import { NextResponse } from "next/server";
import { unityManager } from "@/lib/unity-editor-log/unityManager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  const debug = unityManager.getDebugInfo();
  return NextResponse.json({
    status: unityManager.getStatus(),
    running: unityManager.isRunning(),
    logPath: unityManager.getActiveLogPath(),
    resolvedLogPath: debug.resolvedLogPath,
    logFileName: debug.logFileName,
    logSourceType: debug.logSourceType,
    detectedProjectPath: debug.detectedProjectPath,
    detectedProductName: debug.detectedProductName,
    logFileExists: debug.logFileExists,
    watcherStarted: debug.watcherStarted,
    lastError: debug.lastError,
    lastLineAt: debug.lastLineAt,
    analyticsEventsSeenCount: debug.analyticsEventsSeenCount,
    rawLinesSeenCount: debug.rawLinesSeenCount,
    analyticsCandidateLinesCount: debug.analyticsCandidateLinesCount,
    lastRawLineAt: debug.lastRawLineAt,
    initialTailRead: debug.initialTailRead,
    initialTailLinesCount: debug.initialTailLinesCount,
    lastRawLine: debug.lastRawLine,
    lastExtractedEvent: debug.lastExtractedEvent,
    lastExtractedAnalyticsType: debug.lastExtractedAnalyticsType,
    tailMode: debug.tailMode,
    bufferedCount: unityManager.getBufferedLogs().length,
  });
}
