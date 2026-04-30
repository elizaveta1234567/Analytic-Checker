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
    return NextResponse.json({
      success: true,
      status: unityManager.getStatus(),
      logPath: unityManager.getActiveLogPath(),
      bufferedCount: unityManager.getBufferedLogs().length,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ success: false, error: message });
  }
}
