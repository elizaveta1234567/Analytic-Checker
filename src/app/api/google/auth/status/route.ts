import { NextResponse } from "next/server";
import { getGoogleAuthStatus } from "@/lib/google-sheets/oauth";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    success: true,
    ...getGoogleAuthStatus(),
  });
}
