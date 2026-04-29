import { NextResponse } from "next/server";
import { adbManager } from "@/lib/android-adb/adbManager";

export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    const body = rawBody.trim() ? JSON.parse(rawBody) : undefined;
    const packageNameOverride =
      body &&
      typeof body === "object" &&
      typeof body.packageName === "string"
        ? body.packageName
        : undefined;

    await adbManager.start(packageNameOverride);
    return NextResponse.json({ success: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ success: false, error: message });
  }
}
