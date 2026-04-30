import { NextResponse } from "next/server";
import { adbManager } from "@/lib/android-adb/adbManager";

export async function POST() {
  try {
    const packageName = await adbManager.detectForegroundPackageName();
    return NextResponse.json({ success: true, packageName });
  } catch (e) {
    return NextResponse.json(
      {
        success: false,
        error:
          e instanceof Error
            ? e.message
            : "Could not detect foreground Android package. Make sure the app is open on device.",
      },
      { status: 500 },
    );
  }
}
