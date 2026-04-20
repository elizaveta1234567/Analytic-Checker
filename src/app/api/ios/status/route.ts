import { NextResponse } from "next/server";
import { iosManager } from "@/lib/ios-idevicesyslog/iosManager";

export function GET() {
  return NextResponse.json({
    running: iosManager.isRunning(),
    bufferedCount: iosManager.getBufferedLogs().length,
  });
}
