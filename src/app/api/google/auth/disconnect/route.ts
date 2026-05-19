import { NextResponse } from "next/server";
import { clearStoredGoogleTokens } from "@/lib/google-sheets/oauth";

export const runtime = "nodejs";

export async function POST() {
  clearStoredGoogleTokens();
  return NextResponse.json({ success: true });
}
