import { NextResponse } from "next/server";
import { iosManager } from "@/lib/ios-idevicesyslog/iosManager";

export function POST() {
  iosManager.stop();
  return NextResponse.json({ success: true });
}
