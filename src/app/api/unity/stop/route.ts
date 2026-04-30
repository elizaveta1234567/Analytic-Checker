import { NextResponse } from "next/server";
import { unityManager } from "@/lib/unity-editor-log/unityManager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST() {
  unityManager.stop();
  return NextResponse.json({ success: true });
}
