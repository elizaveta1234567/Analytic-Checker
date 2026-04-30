import { NextResponse } from "next/server";
import { unityManager } from "@/lib/unity-editor-log/unityManager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    status: unityManager.getStatus(),
    running: unityManager.isRunning(),
    logPath: unityManager.getActiveLogPath(),
    bufferedCount: unityManager.getBufferedLogs().length,
  });
}
