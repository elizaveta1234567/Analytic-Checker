import { NextResponse } from "next/server";
import { getGoogleSheetsAccessToken } from "@/lib/google-sheets/oauth";
import {
  buildGoogleSheetRowIndex,
  GoogleSheetSyncError,
} from "@/lib/google-sheets/sheetsApi";

export const runtime = "nodejs";

type RowIndexRequestBody = {
  spreadsheetId?: unknown;
  sheetTitle?: unknown;
  manualSheetTitle?: unknown;
  force?: unknown;
};

function googleSheetRowIndexError(error: unknown): {
  message: string;
  status: number;
  technicalDetail?: string;
  networkIssue: boolean;
} {
  if (error instanceof GoogleSheetSyncError) {
    return {
      message: error.message,
      status: error.status,
      technicalDetail: error.technicalDetail,
      networkIssue: error.isNetworkError,
    };
  }
  return {
    message: error instanceof Error ? error.message : String(error),
    status: 500,
    networkIssue: false,
  };
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as
      | RowIndexRequestBody
      | null;
    const spreadsheetId =
      typeof body?.spreadsheetId === "string" ? body.spreadsheetId.trim() : "";
    const manualSheetTitle =
      typeof body?.manualSheetTitle === "string"
        ? body.manualSheetTitle.trim()
        : "";
    const sheetTitle =
      manualSheetTitle ||
      (typeof body?.sheetTitle === "string" ? body.sheetTitle.trim() : "");
    const force = body?.force === true;

    if (!spreadsheetId || !sheetTitle) {
      return NextResponse.json(
        {
          success: false,
          error: "Missing spreadsheetId or sheet tab name.",
        },
        { status: 400 },
      );
    }

    console.log("[googleRowIndex] rebuild requested");
    console.log("[googleRowIndex] cacheVersion=v4");

    let accessToken = "";
    try {
      accessToken = await getGoogleSheetsAccessToken();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json(
        {
          success: false,
          error: "Google access token is missing. Reconnect Google.",
          technicalDetail: message,
        },
        { status: 401 },
      );
    }

    const rowIndex = await buildGoogleSheetRowIndex(
      spreadsheetId,
      sheetTitle,
      accessToken,
      { force },
    );

    return NextResponse.json({
      success: true,
      ...rowIndex,
    });
  } catch (error) {
    const parsed = googleSheetRowIndexError(error);
    console.error("[google-sheet-row-index] failed", error);
    return NextResponse.json(
      {
        success: false,
        error: parsed.message,
        technicalDetail: parsed.technicalDetail,
        networkIssue: parsed.networkIssue,
      },
      { status: parsed.status },
    );
  }
}
