import { NextResponse } from "next/server";
import { iosManager } from "@/lib/ios-idevicesyslog/iosManager";

export async function POST() {
  try {
    await iosManager.start();
    return NextResponse.json({ success: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ success: false, error: message });
  }
}
