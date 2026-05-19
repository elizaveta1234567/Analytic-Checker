import { NextResponse } from "next/server";
import { unityManager } from "@/lib/unity-editor-log/unityManager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    const body = rawBody.trim() ? JSON.parse(rawBody) : undefined;
    const logPathOverride =
      body && typeof body === "object" && typeof body.logPath === "string"
        ? body.logPath
        : undefined;

    await unityManager.start(logPathOverride);
    const debug = unityManager.getDebugInfo();
    return NextResponse.json({
      success: true,
      status: unityManager.getStatus(),
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
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const errorCode =
      typeof (e as { errorCode?: unknown } | null)?.errorCode === "string"
        ? (e as { errorCode: string }).errorCode
        : null;
    const debug = unityManager.getDebugInfo();
    return NextResponse.json({
      success: false,
      error: message,
      errorCode,
      status: unityManager.getStatus(),
      logPath: unityManager.getActiveLogPath(),
      resolvedLogPath: debug.resolvedLogPath,
      logFileName: debug.logFileName,
      logSourceType: debug.logSourceType,
      detectedProjectPath: debug.detectedProjectPath,
      detectedProductName: debug.detectedProductName,
      logFileExists: debug.logFileExists,
      watcherStarted: debug.watcherStarted,
      lastError: debug.lastError ?? message,
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
    });
  }
}
