import { NextResponse } from "next/server";
import { streamState } from "@/lib/android-adb/streamState";

export function POST() {
  try {
    streamState.clear();
    return NextResponse.json({ success: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ success: false, error: message });
  }
}
