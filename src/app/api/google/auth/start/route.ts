import { NextResponse } from "next/server";
import {
  createGoogleAuthUrl,
  getGoogleOAuthRedirectUri,
  logGoogleOAuthConfig,
} from "@/lib/google-sheets/oauth";

export const runtime = "nodejs";

export async function POST() {
  const redirectUri = getGoogleOAuthRedirectUri();
  logGoogleOAuthConfig();
  console.log(`[googleOAuth] redirect_uri=${redirectUri}`);

  try {
    return NextResponse.json({
      success: true,
      authUrl: createGoogleAuthUrl(),
      redirectUri,
      debug: { redirectUri },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      {
        success: false,
        error: message,
        redirectUri,
        debug: { redirectUri },
      },
      { status: 400 },
    );
  }
}
