import { NextResponse } from "next/server";
import { adbManager } from "@/lib/android-adb/adbManager";

export function GET() {
  return NextResponse.json({
    running: adbManager.isRunning(),
    bufferedCount: adbManager.getBufferedLogs().length,
  });
}
