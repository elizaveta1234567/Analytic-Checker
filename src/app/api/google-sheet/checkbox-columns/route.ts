import { NextResponse } from "next/server";
import { getGoogleSheetsAccessToken } from "@/lib/google-sheets/oauth";
import {
  GoogleSheetSyncError,
  resolveGoogleSheetCheckboxColumns,
} from "@/lib/google-sheets/sheetsApi";

export const runtime = "nodejs";

type CheckboxColumnsRequestBody = {
  spreadsheetId?: unknown;
  gid?: unknown;
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

function errorPayload(error: unknown): {
  error: string;
  status: number;
  technicalDetail?: string;
} {
  if (error instanceof GoogleSheetSyncError) {
    return {
      error: error.message,
      status: error.status,
      technicalDetail: error.technicalDetail,
    };
  }

  return {
    error: error instanceof Error ? error.message : String(error),
    status: 500,
  };
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as
      | CheckboxColumnsRequestBody
      | null;
    const spreadsheetId =
      typeof body?.spreadsheetId === "string" ? body.spreadsheetId.trim() : "";
    const gid = typeof body?.gid === "string" ? body.gid.trim() : "";

    if (!spreadsheetId || !gid) {
      return NextResponse.json(
        {
          success: false,
          error: "Missing spreadsheetId or gid.",
          checkboxCandidates: [],
        },
        { status: 400 },
      );
    }

    let accessToken = "";
    try {
      accessToken = await getGoogleSheetsAccessToken();
    } catch (error) {
      return NextResponse.json(
        {
          success: false,
          error: "Google access token is missing. Reconnect Google.",
          technicalDetail:
            error instanceof Error ? error.message : String(error),
          checkboxCandidates: [],
        },
        { status: 401 },
      );
    }

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

    console.log("[googleSheetColumns] retry result", {
      spreadsheetId,
      gid,
      checkboxColumnIndex: result.checkboxColumnIndex,
      checkboxCandidates: result.checkboxCandidates,
      checkboxColumnDetectionError: result.checkboxColumnDetectionError,
    });

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const payload = errorPayload(error);
    console.error("[google-sheet-checkbox-columns] failed", error);
    return NextResponse.json(
      {
        success: false,
        error: payload.error,
        technicalDetail: payload.technicalDetail,
        checkboxCandidates: [],
      },
      { status: payload.status },
    );
  }
}
