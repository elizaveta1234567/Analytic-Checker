import { NextResponse } from "next/server";
import {
  GoogleSheetSyncError,
  syncPassedRowsToGoogleSheet,
  type GoogleSheetPassedUpdate,
} from "@/lib/google-sheets/sheetsApi";

export const runtime = "nodejs";

type SyncRequestBody = {
  spreadsheetId?: unknown;
  gid?: unknown;
  sheetTitle?: unknown;
  manualSheetTitle?: unknown;
  debugLabel?: unknown;
  updates?: unknown;
};

function parseUpdate(value: unknown): GoogleSheetPassedUpdate | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const item = value as Record<string, unknown>;
  if (
    typeof item.rowId !== "string" ||
    typeof item.rowNumber !== "number"
  ) {
    return null;
  }

  return {
    rowId: item.rowId,
    rowNumber: item.rowNumber,
    eventName: typeof item.eventName === "string" ? item.eventName : null,
    checkboxColumnIndex:
      typeof item.checkboxColumnIndex === "number"
        ? item.checkboxColumnIndex
        : null,
    statusColumnIndex:
      typeof item.statusColumnIndex === "number"
        ? item.statusColumnIndex
        : null,
    doneColumnIndex:
      typeof item.doneColumnIndex === "number" ? item.doneColumnIndex : null,
    checkColumnIndex:
      typeof item.checkColumnIndex === "number" ? item.checkColumnIndex : null,
  };
}

function getObjectProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || !(key in value)) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function getErrorCause(error: unknown): unknown {
  return getObjectProperty(error, "cause");
}

function getErrorName(error: unknown): string | undefined {
  return typeof getObjectProperty(error, "name") === "string"
    ? (getObjectProperty(error, "name") as string)
    : undefined;
}

function getErrorMessage(error: unknown): string | undefined {
  return typeof getObjectProperty(error, "message") === "string"
    ? (getObjectProperty(error, "message") as string)
    : undefined;
}

function getCauseCode(error: unknown): string | undefined {
  const cause = getErrorCause(error);
  const code = getObjectProperty(cause, "code");
  return typeof code === "string" || typeof code === "number"
    ? String(code)
    : undefined;
}

function getCauseMessage(error: unknown): string | undefined {
  return getErrorMessage(getErrorCause(error));
}

export async function POST(request: Request) {
  let debugLabel: string | null = null;
  try {
    const body = (await request.json().catch(() => null)) as SyncRequestBody | null;
    const spreadsheetId =
      typeof body?.spreadsheetId === "string" ? body.spreadsheetId : "";
    const gid = typeof body?.gid === "string" ? body.gid : "";
    const sheetTitle =
      typeof body?.sheetTitle === "string" ? body.sheetTitle : null;
    const manualSheetTitle =
      typeof body?.manualSheetTitle === "string" ? body.manualSheetTitle : null;
    debugLabel = typeof body?.debugLabel === "string" ? body.debugLabel : null;
    const updates = Array.isArray(body?.updates)
      ? body.updates.map(parseUpdate).filter((item): item is GoogleSheetPassedUpdate => item !== null)
      : [];

    const result = await syncPassedRowsToGoogleSheet({
      spreadsheetId,
      gid,
      sheetTitle,
      manualSheetTitle,
      debugLabel,
      updates,
    });

    return NextResponse.json({ success: true, ...result });
  } catch (e) {
    const error =
      e instanceof GoogleSheetSyncError
        ? e.message
        : e instanceof Error
          ? e.message
          : String(e);
    const status = e instanceof GoogleSheetSyncError ? e.status : 500;
    const technicalDetail =
      e instanceof GoogleSheetSyncError ? e.technicalDetail : undefined;
    const networkIssue =
      e instanceof GoogleSheetSyncError ? e.isNetworkError : false;
    const errorName =
      e instanceof GoogleSheetSyncError ? e.errorName ?? e.name : getErrorName(e);
    const errorMessage =
      e instanceof GoogleSheetSyncError
        ? e.errorMessage ?? e.message
        : getErrorMessage(e);
    const causeCode =
      e instanceof GoogleSheetSyncError ? e.causeCode : getCauseCode(e);
    const causeMessage =
      e instanceof GoogleSheetSyncError ? e.causeMessage : getCauseMessage(e);
    const attemptCount =
      e instanceof GoogleSheetSyncError ? e.attemptCount : undefined;
    const attempts = e instanceof GoogleSheetSyncError ? e.attempts : undefined;
    if (
      debugLabel === "testWrite" ||
      debugLabel === "exactG69" ||
      debugLabel === "exactG69A1" ||
      debugLabel === "exactG85" ||
      debugLabel === "exactG85A1"
    ) {
      console.error("[googleSheetTestWrite] failed");
      console.error(`[googleSheetTestWrite] errorName=${errorName ?? "null"}`);
      console.error(
        `[googleSheetTestWrite] errorMessage=${errorMessage ?? "null"}`,
      );
      console.error(`[googleSheetTestWrite] causeCode=${causeCode ?? "null"}`);
      console.error(
        `[googleSheetTestWrite] causeMessage=${causeMessage ?? "null"}`,
      );
      console.error(
        `[googleSheetTestWrite] technicalDetail=${technicalDetail ?? "null"}`,
      );
      console.error(
        `[googleSheetTestWrite] attemptCount=${attemptCount ?? "null"}`,
      );
      for (const attempt of attempts ?? []) {
        console.error(
          `[googleSheetTestWrite] attempt=${attempt.attempt}/${attempt.maxAttempts} transport=${attempt.transport} errorName=${attempt.errorName ?? "null"} errorMessage=${attempt.errorMessage ?? "null"} causeCode=${attempt.causeCode ?? "null"} causeMessage=${attempt.causeMessage ?? "null"} technicalDetail=${attempt.technicalDetail}`,
        );
      }
    }
    console.error("[google-sheet-sync] failed", e);
    return NextResponse.json(
      {
        success: false,
        error,
        technicalDetail,
        networkIssue,
        errorName,
        errorMessage,
        causeCode,
        causeMessage,
        attemptCount,
        attempts,
      },
      { status },
    );
  }
}
