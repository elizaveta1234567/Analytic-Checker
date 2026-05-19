import { NextResponse } from "next/server";
import { getGoogleSheetsAccessToken } from "@/lib/google-sheets/oauth";
import {
  GoogleSheetSyncError,
  resolveGoogleSheetTitle,
  resolveGoogleSheetTitleWithDebug,
} from "@/lib/google-sheets/sheetsApi";

export const runtime = "nodejs";

type TitleRequestBody = {
  spreadsheetId?: unknown;
  gid?: unknown;
};

function errorPayload(e: unknown) {
  const error =
    e instanceof GoogleSheetSyncError
      ? e.technicalDetail ?? e.message
      : e instanceof Error
        ? e.message
        : String(e);
  const status = e instanceof GoogleSheetSyncError ? e.status : 500;
  const technicalDetail =
    e instanceof GoogleSheetSyncError ? e.technicalDetail : undefined;
  const availableSheets =
    e instanceof GoogleSheetSyncError ? e.availableSheets ?? [] : [];
  const networkIssue =
    e instanceof GoogleSheetSyncError ? e.isNetworkError : false;
  return { error, status, technicalDetail, availableSheets, networkIssue };
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as
      | TitleRequestBody
      | null;
    const spreadsheetId =
      typeof body?.spreadsheetId === "string" ? body.spreadsheetId : "";
    const gid = typeof body?.gid === "string" ? body.gid : "";

    if (!spreadsheetId.trim() || !gid.trim()) {
      return NextResponse.json(
        {
          success: false,
          error: "Could not resolve Google Sheet tab name.",
          technicalDetail: "Missing spreadsheetId or gid.",
        },
        { status: 400 },
      );
    }

    const accessToken = await getGoogleSheetsAccessToken();
    const sheetTitle = await resolveGoogleSheetTitle(
      spreadsheetId,
      gid,
      accessToken,
    );

    return NextResponse.json({ success: true, sheetTitle });
  } catch (e) {
    const { error, status, technicalDetail, availableSheets, networkIssue } =
      errorPayload(e);
    console.error("[google-sheet-title] failed", e);
    return NextResponse.json(
      { success: false, error, technicalDetail, availableSheets, networkIssue },
      { status },
    );
  }
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const spreadsheetId = url.searchParams.get("spreadsheetId")?.trim() ?? "";
    const gid = url.searchParams.get("gid")?.trim() ?? "";

    if (!spreadsheetId || !gid) {
      return NextResponse.json(
        {
          success: false,
          error: "Missing spreadsheetId or gid.",
          availableSheets: [],
        },
        { status: 400 },
      );
    }

    const accessToken = await getGoogleSheetsAccessToken();
    const { sheetTitle, availableSheets } =
      await resolveGoogleSheetTitleWithDebug(
        spreadsheetId,
        gid,
        accessToken,
        0,
        false,
      );

    return NextResponse.json({
      success: true,
      sheetTitle,
      availableSheets,
    });
  } catch (e) {
    const { error, status, technicalDetail, availableSheets, networkIssue } =
      errorPayload(e);
    console.error("[google-sheet-title] failed", e);
    return NextResponse.json(
      { success: false, error, technicalDetail, availableSheets, networkIssue },
      { status },
    );
  }
}
