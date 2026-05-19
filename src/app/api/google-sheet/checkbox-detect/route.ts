import { NextResponse } from "next/server";
import { getGoogleSheetsAccessToken } from "@/lib/google-sheets/oauth";
import {
  GoogleSheetSyncError,
  resolveGoogleSheetCheckboxColumns,
} from "@/lib/google-sheets/sheetsApi";

export const runtime = "nodejs";

type CheckboxDetectRequestBody = {
  spreadsheetId?: unknown;
  gid?: unknown;
  sourceUrl?: unknown;
  headers?: unknown;
  preferredColumnIndex?: unknown;
  rowNumbers?: unknown;
};

function parseHeaders(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parsePreferredColumnIndex(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function parseRowNumbers(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is number =>
          typeof item === "number" && Number.isInteger(item) && item > 0,
      )
    : [];
}

function checkboxDetectionError(error: unknown): {
  message: string;
  status: number;
  networkIssue: boolean;
} {
  if (error instanceof GoogleSheetSyncError) {
    return {
      message: error.technicalDetail ?? error.message,
      status: error.status,
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
      | CheckboxDetectRequestBody
      | null;
    const spreadsheetId =
      typeof body?.spreadsheetId === "string" ? body.spreadsheetId.trim() : "";
    const gid = typeof body?.gid === "string" ? body.gid.trim() : "";
    const sourceUrl =
      typeof body?.sourceUrl === "string" ? body.sourceUrl.trim() : "";

    if (!spreadsheetId || !gid) {
      return NextResponse.json(
        {
          success: false,
          checkboxColumnIndex: null,
          checkboxCandidates: [],
          error: "Missing spreadsheetId or gid.",
        },
        { status: 400 },
      );
    }

    let accessToken = "";
    try {
      accessToken = await getGoogleSheetsAccessToken();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json(
        {
          success: false,
          checkboxColumnIndex: null,
          checkboxCandidates: [],
          error: "Google access token is missing. Reconnect Google.",
          checkboxColumnDetectionError: message,
        },
        { status: 401 },
      );
    }

    console.log("[googleSheetColumns] checkbox-detect request", {
      spreadsheetId,
      gid,
      sourceUrlExists: Boolean(sourceUrl),
    });

    const result = await resolveGoogleSheetCheckboxColumns(
      spreadsheetId,
      gid,
      accessToken,
      {
        headers: parseHeaders(body?.headers),
        preferredColumnIndex: parsePreferredColumnIndex(
          body?.preferredColumnIndex,
        ),
        rowNumbers: parseRowNumbers(body?.rowNumbers),
      },
    );

    return NextResponse.json({
      success: true,
      checkboxColumnIndex: result.checkboxColumnIndex,
      checkboxCandidates: result.checkboxCandidates,
      checkboxColumnDetectionError: result.checkboxColumnDetectionError,
      error: result.checkboxColumnDetectionError,
    });
  } catch (error) {
    const detectedError = checkboxDetectionError(error);
    console.error("[google-sheet-checkbox-detect] failed", error);
    return NextResponse.json(
      {
        success: false,
        checkboxColumnIndex: null,
        checkboxCandidates: [],
        checkboxColumnDetectionError: detectedError.message,
        error: detectedError.message,
        networkIssue: detectedError.networkIssue,
      },
      { status: detectedError.status },
    );
  }
}
