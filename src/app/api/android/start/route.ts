import { NextResponse } from "next/server";
import { adbManager } from "@/lib/android-adb/adbManager";

export async function POST() {
  try {
    await adbManager.start();
    return NextResponse.json({ success: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ success: false, error: message });
  }
}
