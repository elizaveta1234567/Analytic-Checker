import { NextResponse } from "next/server";
import { adbManager } from "@/lib/android-adb/adbManager";

export function POST() {
  adbManager.stop();
  return NextResponse.json({ success: true });
}
