import { NextResponse } from "next/server";
import type { IncomingHttpHeaders } from "node:http";
import { get as httpsGet } from "node:https";
import {
  importSpecFromMatrix,
  parseWorkbookToMatrix,
  type ParsedSpecResult,
} from "@/lib/analytics/import";
import type { AnalyticsSpecRow } from "@/lib/analytics/types";
import {
  getGoogleSheetsAccessToken,
  GoogleOAuthMisconfiguredError,
  GoogleOAuthNetworkError,
  GoogleOAuthReconnectRequiredError,
} from "@/lib/google-sheets/oauth";
import {
  type GoogleSheetCheckboxCandidate,
  fetchGoogleSheetGridMatrix,
  GoogleSheetSyncError,
  resolveGoogleSheetCheckboxColumns,
  resolveGoogleSheetTitle,
} from "@/lib/google-sheets/sheetsApi";

export const runtime = "nodejs";

const googleSheetImportError =
  "Could not import Google Sheet. Make sure the sheet is shared with view access or published.";
const googleSheetNetworkImportError =
  "Network issue. Could not import Google Sheet, please try again.";
const httpsRedirectLimit = 5;
const fixedGoogleSheetCheckboxColumnIndex = 6;
const fixedGoogleSheetCheckboxColumnLetter = "G";
const googleSheetConnectionExpiredError =
  "Google connection expired. Connect Google again.";
const googleSheetAccessDeniedError = "No access to Google Sheet.";
const googleSheetNotFoundError = "Google Sheet or tab not found.";
const googleOAuthTimeoutError =
  "Google OAuth is taking too long to respond. Try reconnecting Google.";
const googleOAuthMisconfiguredError =
  "Google OAuth is misconfigured. Check GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET.";

type GoogleSheetImportErrorType =
  | "network"
  | "access"
  | "invalid-url"
  | "unknown";

type GoogleSheetImportPlatform = "android" | "ios" | "unity";

function isGoogleSheetImportNetworkIssue(
  value: string | null | undefined,
): boolean {
  return /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ABORT_ERR|AbortError|This operation was aborted|aborted|timeout|timed out|fetch failed|network|\b503\b/i.test(
    value ?? "",
  );
}

function classifyGoogleSheetImportError(options: {
  error: string;
  status: number;
  technicalDetail?: string;
  explicitType?: GoogleSheetImportErrorType;
}): GoogleSheetImportErrorType {
  if (options.explicitType) {
    return options.explicitType;
  }

  const detail = [options.error, options.technicalDetail]
    .filter(Boolean)
    .join(" ");
  if (
    options.status === 400 &&
    /Invalid Google Sheet URL|Could not determine sheet tab|sheetId not found|gid not found/i.test(
      detail,
    )
  ) {
    return "invalid-url";
  }
  if (
    options.status === 503 ||
    isGoogleSheetImportNetworkIssue(detail)
  ) {
    return "network";
  }
  if (
    options.status === 403 ||
    /permission denied|not shared|No access to Google Sheet|shared with view access/i.test(
      detail,
    )
  ) {
    return "access";
  }
  return "unknown";
}

function logGoogleSheetImportPerf(label: string, startedAt: number): number {
  const elapsed = Date.now() - startedAt;
  console.log(`[googleSheetImportPerf] ${label}Ms=${elapsed}`);
  return elapsed;
}

function googleSheetImportFailure(
  error: string,
  status: number,
  details: Record<string, unknown>,
  technicalDetail?: string,
  explicitType?: GoogleSheetImportErrorType,
) {
  const importErrorType = classifyGoogleSheetImportError({
    error,
    status,
    technicalDetail,
    explicitType,
  });
  const networkIssue = importErrorType === "network";
  const safeError = networkIssue ? googleSheetNetworkImportError : error;
  const responseStatus = networkIssue && status >= 500 ? 503 : status;
  console.error("[google-sheet-import]", safeError, {
    ...details,
    importErrorType,
    networkIssue,
    technicalDetail,
  });
  return NextResponse.json(
    {
      success: false,
      error: safeError,
      technicalDetail,
      importErrorType,
      networkIssue,
    },
    { status: responseStatus },
  );
}

type CsvEndpoint = {
  name: "values.get" | "export" | "gviz fallback";
  url: string;
};

type CsvDownloadSuccess = {
  success: true;
  endpoint: CsvEndpoint;
  transport: "global fetch" | "https fallback";
  csvText: string;
  contentType: string;
  contentDisposition: string | null;
  status: number;
  statusText: string;
};

type CsvDownloadFailure = {
  success: false;
  endpoint: CsvEndpoint;
  transport?: "global fetch" | "https fallback";
  error: string;
  status: number;
  responseStatus?: number;
  statusText?: string;
  contentType?: string;
  textLength?: number;
  technicalDetail: string;
  errorMessage?: string;
  globalFetchError?: string;
  fallbackError?: string;
};

type CsvDownloadAttempt = CsvDownloadSuccess | CsvDownloadFailure;

type ValuesGetFailure = {
  success: false;
  error: string;
  status: number;
  responseStatus?: number;
  statusText?: string;
  technicalDetail: string;
  errorMessage?: string;
};

type ValuesGetHttpResponse = {
  success: true;
  transport: "fetch" | "https fallback";
  status: number;
  statusText: string;
  contentType: string;
  text: string;
  durationMs: number;
};

type ValuesGetTransportResult = ValuesGetHttpResponse | ValuesGetFailure;

type GoogleSheetSourceRow = {
  rowId: string;
  sourceRowIndex: number;
  sourceRowNumber: number;
  importedIndex: number;
  eventName: string;
  normalizedEventName: string;
  googleCheckRange: string | null;
  sourcePathColumns: string[];
  rawRow: string[];
};

type GoogleSheetStaircaseRow = {
  sourceRowIndex: number;
  sourceRowNumber: number;
  rawRow: string[];
};

type GoogleSheetSourceMetadata = {
  spreadsheetId: string;
  gid: string;
  sourceUrl: string;
  selectedPlatform?: GoogleSheetImportPlatform;
  detectedParser?: string | null;
  detectedColumns?: string | null;
  checkboxColumn?: string | null;
  descriptionColumn?: string | null;
  parameterDescriptionColumn?: string | null;
  importedSpecRowsCount?: number;
  firstParsedEvents?: string[];
  importFetchMs?: number | null;
  importParseMs?: number | null;
  importTotalMs?: number | null;
  googleRowsRead?: number | null;
  effectiveRowsParsed?: number | null;
  sheetTitle: string | null;
  manualSheetTitle?: string | null;
  sheetTitleResolutionError: string | null;
  checkboxColumnIndex: number | null;
  statusColumnIndex: number | null;
  checkboxCandidates: GoogleSheetCheckboxCandidate[];
  checkboxColumnDetectionError: string | null;
  checkboxColumnSource: "metadata" | "manual" | "fixed" | null;
  detectedHeaders: string[];
  headerRowIndex: number | null;
  headerRowNumber: number | null;
  doneColumnIndex: number | null;
  checkColumnIndex: number | null;
  rows: GoogleSheetSourceRow[];
  staircaseRows: GoogleSheetStaircaseRow[];
};

type GoogleSheetDetectedColumns = {
  headerRowIndex: number | null;
  headers: string[];
  checkboxColumnIndex: number | null;
  statusColumnIndex: number | null;
};

type GoogleSheetImportMatrix = {
  matrix: string[][];
  checkboxMatrix: boolean[][];
  source: "googleGrid" | "valuesApi" | "csv";
  sheetTitle: string | null;
  debug: {
    sheetNames: string[];
    usedSheetName: string;
    matrixRowCount: number;
    matrixColCount: number;
    googleRowsRead?: number;
    effectiveRowsParsed?: number;
    trimRowsMs?: number | null;
    importFetchMs?: number | null;
    importParseMs?: number | null;
    importTotalMs?: number | null;
  };
};

type UnityStaircaseCandidate = {
  rowIndex: number;
  rowNumber: number;
  rawRow: string[];
  levels: string[];
  eventParts: string[];
  eventName: string;
  normalizedEventName: string;
  actualColumnIndexes: number[];
  description: string;
  parameterDescription: string;
  hasCheckCell: boolean;
};

type PreparedGoogleSheetImportMatrix = {
  matrix: string[][];
  checkboxMatrix: boolean[][];
  effectiveRowsParsed: number;
  trimRowsMs: number | null;
};

function extractSheetId(rawUrl: string): string | null {
  const value = rawUrl.trim();
  if (!value) return null;

  try {
    const url = new URL(value);
    if (url.hostname !== "docs.google.com") {
      return null;
    }

    return (
      url.pathname.match(/\/spreadsheets\/(?:u\/\d+\/)?d\/([^/?#]+)/)?.[1] ??
      null
    );
  } catch {
    return null;
  }
}

function extractGid(rawUrl: string): string | null {
  const value = rawUrl.trim();
  if (!value) return null;

  try {
    const url = new URL(value);
    const queryGid = url.searchParams.get("gid")?.trim();
    if (queryGid) return queryGid;

    const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
    const hashGid = hashParams.get("gid")?.trim();
    if (hashGid) return hashGid;

    return url.hash.match(/[#&?]gid=([^&]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function parseGoogleSheetImportPlatform(
  value: unknown,
): GoogleSheetImportPlatform {
  return value === "ios" || value === "unity" ? value : "android";
}

function getCsvFileName(
  contentDisposition: string | null,
  gid: string,
): string {
  if (contentDisposition) {
    const encodedFileName = contentDisposition.match(
      /filename\*=UTF-8''([^;]+)/i,
    )?.[1];
    if (encodedFileName) {
      try {
        return decodeURIComponent(encodedFileName).replace(/^"|"$/g, "");
      } catch {
        return encodedFileName.replace(/^"|"$/g, "");
      }
    }

    const fileName = contentDisposition.match(/filename="?([^";]+)"?/i)?.[1];
    if (fileName) {
      return fileName.trim();
    }
  }

  return `Google Sheet tab gid=${gid}`;
}

function getErrorDiagnostics(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  const cause =
    error instanceof Error && "cause" in error
      ? String(error.cause)
      : undefined;

  return { message, stack, cause };
}

function looksLikeHtml(text: string): boolean {
  const normalized = text.trimStart().slice(0, 1024).toLowerCase();
  return normalized.startsWith("<!doctype html") || normalized.includes("<html");
}

function normalizeHeaderCell(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

const statusHeaderNames = new Set(
  [
    "check",
    "status",
    "result",
    "passed",
    "verified",
    "\u043f\u0440\u043e\u0432\u0435\u0440\u0435\u043d\u043e",
    "\u0441\u0442\u0430\u0442\u0443\u0441",
  ].map(normalizeHeaderCell),
);

function isBooleanText(value: string): boolean {
  return /^(true|false)$/i.test(value.trim());
}

function isPassedLikeText(value: string): boolean {
  return /^(passed|fail|failed|true|false)$/i.test(value.trim());
}

function isBooleanLikeCell(
  matrix: string[][],
  checkboxMatrix: boolean[][],
  rowIndex: number,
  columnIndex: number,
): boolean {
  return (
    checkboxMatrix[rowIndex]?.[columnIndex] === true ||
    isBooleanText(matrix[rowIndex]?.[columnIndex] ?? "")
  );
}

function getMatrixColumnCount(matrix: string[][]): number {
  return matrix.reduce((max, row) => Math.max(max, row.length), 0);
}

function findCheckboxColumnIndex(
  matrix: string[][],
  checkboxMatrix: boolean[][],
): number | null {
  const columnCount = getMatrixColumnCount(matrix);
  let best: { index: number; booleanCount: number } | null = null;

  for (let columnIndex = 0; columnIndex < columnCount; columnIndex++) {
    let booleanCount = 0;
    let nonBooleanTextCount = 0;
    let passedTextCount = 0;

    for (let rowIndex = 0; rowIndex < matrix.length; rowIndex++) {
      const value = matrix[rowIndex]?.[columnIndex]?.trim() ?? "";
      if (!value) {
        continue;
      }
      if (isBooleanLikeCell(matrix, checkboxMatrix, rowIndex, columnIndex)) {
        booleanCount++;
        continue;
      }
      if (isPassedLikeText(value)) {
        passedTextCount++;
      }
      nonBooleanTextCount++;
    }

    if (booleanCount === 0 || passedTextCount > 0) {
      continue;
    }

    if (nonBooleanTextCount > Math.max(3, Math.floor(booleanCount * 0.2))) {
      continue;
    }

    if (best === null || booleanCount > best.booleanCount) {
      best = { index: columnIndex, booleanCount };
    }
  }

  return best?.index ?? null;
}

function findHeaderRowIndex(
  matrix: string[][],
  checkboxMatrix: boolean[][],
  checkboxColumnIndex: number | null,
): number | null {
  const scanLimit = Math.min(matrix.length, 25);
  for (let rowIndex = 0; rowIndex < scanLimit; rowIndex++) {
    if (
      matrix[rowIndex]?.some((cell) =>
        statusHeaderNames.has(normalizeHeaderCell(cell)),
      )
    ) {
      return rowIndex;
    }
  }

  const firstBooleanRow =
    checkboxColumnIndex === null
      ? -1
      : matrix.findIndex((_, rowIndex) =>
          isBooleanLikeCell(matrix, checkboxMatrix, rowIndex, checkboxColumnIndex),
        );

  if (firstBooleanRow > 0) {
    for (let rowIndex = firstBooleanRow - 1; rowIndex >= 0; rowIndex--) {
      if (matrix[rowIndex]?.some((cell) => cell.trim().length > 0)) {
        return rowIndex;
      }
    }
  }

  return null;
}

function detectGoogleSheetColumns(
  matrix: string[][],
  checkboxMatrix: boolean[][],
): GoogleSheetDetectedColumns {
  const checkboxColumnIndex = findCheckboxColumnIndex(matrix, checkboxMatrix);
  const headerRowIndex = findHeaderRowIndex(
    matrix,
    checkboxMatrix,
    checkboxColumnIndex,
  );
  const headers =
    headerRowIndex === null ? [] : [...(matrix[headerRowIndex] ?? [])];
  let statusColumnIndex: number | null = null;

  for (let index = 0; index < headers.length; index++) {
    if (
      index !== checkboxColumnIndex &&
      statusHeaderNames.has(normalizeHeaderCell(headers[index] ?? "")) &&
      !matrix.some((_, rowIndex) =>
        isBooleanLikeCell(matrix, checkboxMatrix, rowIndex, index),
      )
    ) {
      statusColumnIndex = index;
      break;
    }
  }

  console.log(`[googleSheetColumns] headers=${JSON.stringify(headers)}`);
  console.log(`[googleSheetColumns] checkboxColumnIndex=${checkboxColumnIndex}`);
  console.log(`[googleSheetColumns] statusColumnIndex=${statusColumnIndex}`);

  return {
    headerRowIndex,
    headers,
    checkboxColumnIndex,
    statusColumnIndex,
  };
}

function buildFixedGoogleSheetCheckboxMatrix(
  matrix: string[][],
  checkboxMatrix: boolean[][],
): boolean[][] {
  return matrix.map((row, rowIndex) => {
    const width = Math.max(row.length, fixedGoogleSheetCheckboxColumnIndex + 1);
    const next = checkboxMatrix[rowIndex]?.slice(0, width) ?? [];
    while (next.length < width) {
      next.push(false);
    }
    const fixedColumnValue =
      row[fixedGoogleSheetCheckboxColumnIndex]?.trim() ?? "";
    next[fixedGoogleSheetCheckboxColumnIndex] =
      next[fixedGoogleSheetCheckboxColumnIndex] ||
      isBooleanText(fixedColumnValue);
    return next;
  });
}

function countFixedGoogleSheetCheckboxRows(
  checkboxMatrix: boolean[][],
): number {
  return checkboxMatrix.reduce(
    (count, row) =>
      count + (row[fixedGoogleSheetCheckboxColumnIndex] ? 1 : 0),
    0,
  );
}

function getStringArrayMeta(row: AnalyticsSpecRow, key: string): string[] {
  const value = row.meta?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function getSourceRowNumber(row: AnalyticsSpecRow): number | null {
  const metaSourceRowNumber = row.meta?.sourceRowNumber;
  if (
    typeof metaSourceRowNumber === "number" &&
    Number.isInteger(metaSourceRowNumber) &&
    metaSourceRowNumber > 0
  ) {
    return metaSourceRowNumber;
  }

  const cellSourceRowNumber = row.cells.sourceRowNumber;
  if (
    typeof cellSourceRowNumber === "number" &&
    Number.isInteger(cellSourceRowNumber) &&
    cellSourceRowNumber > 0
  ) {
    return cellSourceRowNumber;
  }

  const rawIndex = row.meta?.sheetRowIndex ?? row.cells.sheetRowIndex;
  if (typeof rawIndex !== "number" || !Number.isInteger(rawIndex)) {
    return null;
  }

  return rawIndex + 1;
}

function getRowEventName(row: AnalyticsSpecRow): string {
  return [row.cells.eventPath, row.cells.value].filter(Boolean).join(".");
}

function normalizeGoogleSheetEventName(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim().replace(/\s+/g, ".").toLowerCase();
}

function quoteSheetTitleForA1(sheetTitle: string): string {
  const trimmed = sheetTitle.trim();
  const unquoted =
    trimmed.length >= 2 &&
    ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"')))
      ? trimmed.slice(1, -1).trim()
      : trimmed;
  return `'${unquoted.replace(/'/g, "''")}'`;
}

function buildGoogleCheckRange(
  sheetTitle: string | null | undefined,
  sourceRowNumber: number,
): string | null {
  const title = sheetTitle?.trim();
  if (!title || !Number.isInteger(sourceRowNumber) || sourceRowNumber <= 0) {
    return null;
  }
  return `${quoteSheetTitleForA1(title)}!${fixedGoogleSheetCheckboxColumnLetter}${sourceRowNumber}`;
}

const googleSheetRowMapDebugEvents = new Set([
  "funnel.splashscreen",
  "funnel.onboarding.step1",
  "funnel.onboarding.step2",
]);

function buildSourceRows(
  rows: AnalyticsSpecRow[],
  sheetTitle: string | null | undefined,
): GoogleSheetSourceRow[] {
  const sourceRows = rows.flatMap((row, importedIndex) => {
    const sourceRowNumber = getSourceRowNumber(row);
    if (sourceRowNumber === null) {
      return [];
    }
    const eventName = getRowEventName(row);
    return [
      {
        rowId: row.id,
        sourceRowIndex: sourceRowNumber - 1,
        sourceRowNumber,
        importedIndex,
        eventName,
        normalizedEventName: normalizeGoogleSheetEventName(eventName),
        googleCheckRange: buildGoogleCheckRange(sheetTitle, sourceRowNumber),
        sourcePathColumns: getStringArrayMeta(row, "sourcePathColumns"),
        rawRow: getStringArrayMeta(row, "rawRow"),
      },
    ];
  });
  for (const sourceRow of sourceRows) {
    console.log(
      `[googleSheetRowMap] event=${sourceRow.eventName} matrixRowIndex=${sourceRow.sourceRowIndex} sourceRowNumber=${sourceRow.sourceRowNumber}`,
    );
    if (googleSheetRowMapDebugEvents.has(sourceRow.eventName)) {
      console.log(
        `[googleSheetRowMapDump] eventName=${sourceRow.eventName} rowId=${sourceRow.rowId} parsedIndex=${sourceRow.importedIndex} sourceRowNumber=${sourceRow.sourceRowNumber} originalMatrixRowIndex=${sourceRow.sourceRowIndex} rawRow=${JSON.stringify(sourceRow.rawRow)}`,
      );
    }
  }
  console.log(
    `[googleSheetRowMapDump] rowsSample=${JSON.stringify(
      sampleSourceRowsForLog(sourceRows),
    )} totalRows=${sourceRows.length}`,
  );
  const firstSourceRow = sourceRows[0] ?? null;
  console.log(
    `[googleSheetImport] firstSourceRowNumber=${
      firstSourceRow?.sourceRowNumber ?? "null"
    }`,
  );
  if (firstSourceRow) {
    console.log(
      `[googleSheetImport] firstSourceRow event=${firstSourceRow.eventName} rowId=${firstSourceRow.rowId} importedIndex=${firstSourceRow.importedIndex}`,
    );
  }
  return sourceRows;
}

function buildStaircaseRows(matrix: string[][]): GoogleSheetStaircaseRow[] {
  return matrix
    .map((rawRow, sourceRowIndex) => ({
      sourceRowIndex,
      sourceRowNumber: sourceRowIndex + 1,
      rawRow: rawRow.map((cell) => normalizeValuesCell(cell)),
    }))
    .filter((row) => row.rawRow.some((cell) => cell.trim().length > 0));
}

function sampleSourceRowsForLog(sourceRows: GoogleSheetSourceRow[]) {
  return sourceRows.slice(0, 20).map((sourceRow) => ({
    eventName: sourceRow.eventName,
    rowId: sourceRow.rowId,
    parsedIndex: sourceRow.importedIndex,
    sourceRowNumber: sourceRow.sourceRowNumber,
    googleCheckRange: sourceRow.googleCheckRange,
    originalMatrixRowIndex: sourceRow.sourceRowIndex,
    rawRow: sourceRow.rawRow,
  }));
}

const unityStaircaseParserName = "unity-staircase";
const unityEventColumnCount = 6;
const unityImportColumnCount = 9;
const unityDescriptionColumnIndex = 7;
const unityParameterDescriptionColumnIndex = 8;
const unityRootHeaderToken =
  "\u043a\u043e\u0440\u043d\u0435\u0432\u043e\u0435 \u0441\u043e\u0431\u044b\u0442\u0438\u0435";
const unityParameterHeaderToken =
  "\u043f\u0430\u0440\u0430\u043c\u0435\u0442\u0440";
const unityEventDescriptionHeaderToken =
  "\u043e\u043f\u0438\u0441\u0430\u043d\u0438\u0435 \u0441\u043e\u0431\u044b\u0442\u0438\u044f";

function trimUnityStaircaseMatrix(
  matrix: string[][],
  checkboxMatrix: boolean[][],
): PreparedGoogleSheetImportMatrix {
  const startedAt = Date.now();
  let lastNonEmptyRowIndex = -1;

  for (let rowIndex = 0; rowIndex < matrix.length; rowIndex++) {
    const row = matrix[rowIndex] ?? [];
    for (let columnIndex = 0; columnIndex < unityImportColumnCount; columnIndex++) {
      if (normalizeValuesCell(row[columnIndex] ?? "").trim()) {
        lastNonEmptyRowIndex = rowIndex;
        break;
      }
    }
  }

  const effectiveRowsParsed = lastNonEmptyRowIndex + 1;
  const trimmedMatrix = matrix
    .slice(0, effectiveRowsParsed)
    .map((row) => {
      const next: string[] = [];
      for (let columnIndex = 0; columnIndex < unityImportColumnCount; columnIndex++) {
        next.push(normalizeValuesCell(row[columnIndex] ?? ""));
      }
      return next;
    });
  const trimmedCheckboxMatrix = checkboxMatrix
    .slice(0, effectiveRowsParsed)
    .map((row) => {
      const next: boolean[] = [];
      for (let columnIndex = 0; columnIndex < unityImportColumnCount; columnIndex++) {
        next.push(row[columnIndex] === true);
      }
      return next;
    });
  const trimRowsMs = Date.now() - startedAt;

  console.log(
    `[unityParser] trimRowsMs=${trimRowsMs} effectiveRows=${effectiveRowsParsed}`,
  );

  return {
    matrix: trimmedMatrix,
    checkboxMatrix: trimmedCheckboxMatrix,
    effectiveRowsParsed,
    trimRowsMs,
  };
}

function normalizeUnityEventPart(value: string): string {
  return value
    .trim()
    .replace(/\s*\.\s*/g, ".")
    .replace(/\.+/g, ".")
    .replace(/^\./, "")
    .replace(/\.$/, "");
}

function normalizeUnityEventNameFromParts(parts: string[]): string {
  return parts
    .map(normalizeUnityEventPart)
    .filter(Boolean)
    .join(".")
    .replace(/\.+/g, ".")
    .replace(/^\./, "")
    .replace(/\.$/, "");
}

function unityHeaderCellMatches(
  row: string[],
  columnIndex: number,
  expected: string,
): boolean {
  return normalizeHeaderCell(row[columnIndex] ?? "").includes(expected);
}

function findUnityStaircaseHeaderRowIndex(matrix: string[][]): number | null {
  const scanLimit = Math.min(matrix.length, 50);
  let best: { rowIndex: number; score: number } | null = null;

  for (let rowIndex = 0; rowIndex < scanLimit; rowIndex++) {
    const row = matrix[rowIndex] ?? [];
    let score = 0;
    if (unityHeaderCellMatches(row, 0, unityRootHeaderToken)) score++;
    for (let columnIndex = 1; columnIndex < unityEventColumnCount; columnIndex++) {
      const expected = `${unityParameterHeaderToken} (${columnIndex})`;
      if (unityHeaderCellMatches(row, columnIndex, expected)) score++;
    }
    if (normalizeHeaderCell(row[fixedGoogleSheetCheckboxColumnIndex] ?? "") === "check") {
      score++;
    }
    if (
      unityHeaderCellMatches(
        row,
        unityDescriptionColumnIndex,
        unityEventDescriptionHeaderToken,
      )
    ) {
      score++;
    }

    if (best === null || score > best.score) {
      best = { rowIndex, score };
    }
    if (score >= 7) {
      return rowIndex;
    }
  }

  return best !== null && best.score >= 5 ? best.rowIndex : null;
}

function unityEventNameContainsHeaderLabel(eventName: string): boolean {
  const normalized = normalizeHeaderCell(eventName);
  return (
    normalized.includes(unityRootHeaderToken) ||
    normalized.includes(unityParameterHeaderToken) ||
    normalized.includes(unityEventDescriptionHeaderToken) ||
    normalized.includes("check")
  );
}

function hasUnityCandidateChild(
  candidates: UnityStaircaseCandidate[],
  candidateIndex: number,
): boolean {
  const candidate = candidates[candidateIndex];
  if (!candidate || candidate.actualColumnIndexes.length === 0) {
    return false;
  }

  const deepestActualColumnIndex = Math.max(...candidate.actualColumnIndexes);
  if (
    deepestActualColumnIndex >= unityEventColumnCount - 1 ||
    !candidate.levels[deepestActualColumnIndex]
  ) {
    return false;
  }

  for (let index = candidateIndex + 1; index < candidates.length; index++) {
    const next = candidates[index];
    const sameContext = candidate.levels
      .slice(0, deepestActualColumnIndex + 1)
      .every(
        (level, levelIndex) =>
          level.length > 0 && next.levels[levelIndex] === level,
      );
    if (!sameContext) {
      break;
    }
    if (
      next.actualColumnIndexes.some(
        (columnIndex) =>
          columnIndex > deepestActualColumnIndex &&
          columnIndex < unityEventColumnCount,
      )
    ) {
      return true;
    }
  }

  return false;
}

function importUnityStaircaseSpecFromMatrix(
  matrix: string[][],
  checkboxMatrix: boolean[][],
  source: { fileName: string; fileSize: number },
  matrixDebug: GoogleSheetImportMatrix["debug"],
): ParsedSpecResult {
  const headerRowIndex = findUnityStaircaseHeaderRowIndex(matrix);
  const levels = Array.from({ length: unityEventColumnCount }, () => "");
  const candidates: UnityStaircaseCandidate[] = [];
  const startRowIndex = headerRowIndex === null ? 0 : headerRowIndex + 1;

  for (let rowIndex = startRowIndex; rowIndex < matrix.length; rowIndex++) {
    const rowWidth = Math.max(
      matrix[rowIndex]?.length ?? 0,
      unityParameterDescriptionColumnIndex + 1,
    );
    const rawRow: string[] = [];
    for (let columnIndex = 0; columnIndex < rowWidth; columnIndex++) {
      rawRow.push(normalizeValuesCell(matrix[rowIndex]?.[columnIndex] ?? ""));
    }
    if (rawRow.every((cell) => cell.trim().length === 0)) {
      continue;
    }

    const actualColumnIndexes: number[] = [];
    for (let columnIndex = 0; columnIndex < unityEventColumnCount; columnIndex++) {
      const value = normalizeUnityEventPart(rawRow[columnIndex] ?? "");
      if (!value) {
        continue;
      }
      levels[columnIndex] = value;
      for (let resetIndex = columnIndex + 1; resetIndex < levels.length; resetIndex++) {
        levels[resetIndex] = "";
      }
      actualColumnIndexes.push(columnIndex);
    }

    if (actualColumnIndexes.length === 0) {
      continue;
    }

    const eventParts = levels.filter(Boolean);
    const eventName = normalizeUnityEventNameFromParts(eventParts);
    const normalizedEventName = normalizeGoogleSheetEventName(eventName);
    if (!eventName || unityEventNameContainsHeaderLabel(eventName)) {
      continue;
    }

    const gValue = rawRow[fixedGoogleSheetCheckboxColumnIndex]?.trim() ?? "";
    candidates.push({
      rowIndex,
      rowNumber: rowIndex + 1,
      rawRow,
      levels: [...levels],
      eventParts,
      eventName,
      normalizedEventName,
      actualColumnIndexes,
      description: rawRow[unityDescriptionColumnIndex]?.trim() ?? "",
      parameterDescription:
        rawRow[unityParameterDescriptionColumnIndex]?.trim() ?? "",
      hasCheckCell:
        checkboxMatrix[rowIndex]?.[fixedGoogleSheetCheckboxColumnIndex] ===
          true || isBooleanText(gValue),
    });
  }

  const warnings: string[] =
    headerRowIndex === null
      ? ["Unity staircase header row was not detected; parsed from the first row."]
      : [];
  const rows: AnalyticsSpecRow[] = [];
  const seenKeys = new Set<string>();

  for (const [candidateIndex, candidate] of candidates.entries()) {
    const hasChildren = hasUnityCandidateChild(candidates, candidateIndex);
    const normalizedParts = candidate.normalizedEventName
      .split(".")
      .filter(Boolean);
    const isLeafOrChecked = !hasChildren || candidate.hasCheckCell;
    if (normalizedParts.length < 2 || !isLeafOrChecked) {
      continue;
    }

    const dedupeKey = `${candidate.normalizedEventName}\0${candidate.rowNumber}`;
    if (seenKeys.has(dedupeKey)) {
      warnings.push(
        `duplicate unity parsed row (sheet row ${candidate.rowNumber}, "${candidate.eventName}")`,
      );
    } else {
      seenKeys.add(dedupeKey);
    }

    const hierarchy = candidate.eventName.split(".").filter(Boolean);
    const description =
      candidate.description || candidate.parameterDescription || "";
    rows.push({
      id: `unity-spec-${candidate.rowNumber}`,
      hierarchy,
      cells: {
        label: hierarchy[hierarchy.length - 1] ?? candidate.eventName,
        eventPath: candidate.eventName,
        description,
        parameterDescription: candidate.parameterDescription,
        value: null,
        sheetRowIndex: candidate.rowIndex,
        sourceRowNumber: candidate.rowNumber,
        level: Math.max(0, hierarchy.length - 1),
      },
      status: "not_checked",
      meta: {
        parser: unityStaircaseParserName,
        sheetRowIndex: candidate.rowIndex,
        sourceRowNumber: candidate.rowNumber,
        level: Math.max(0, hierarchy.length - 1),
        eventName: candidate.eventName,
        normalizedEventName: candidate.normalizedEventName,
        fullPath: candidate.eventName,
        sourcePathColumns: [...candidate.eventParts],
        actualColumnIndexes: [...candidate.actualColumnIndexes],
        description: candidate.description,
        parameterDescription: candidate.parameterDescription,
        rawRow: [...candidate.rawRow],
      },
    });
  }

  if (rows.length === 0) {
    warnings.push("Unity staircase parser found no importable spec rows.");
  }

  const firstParsedEvents = rows
    .slice(0, 20)
    .map((row) => getRowEventName(row))
    .filter(Boolean);

  return {
    rows,
    warnings,
    debug: {
      fileName: source.fileName,
      fileSize: source.fileSize,
      sheetNames: matrixDebug.sheetNames ?? [],
      usedSheetName: matrixDebug.usedSheetName ?? "",
      matrixRowCount: matrixDebug.matrixRowCount ?? matrix.length,
      matrixColCount:
        matrixDebug.matrixColCount ?? getMatrixColumnCount(matrix),
      googleRowsRead: matrixDebug.googleRowsRead ?? matrix.length,
      effectiveRowsParsed: matrixDebug.effectiveRowsParsed ?? matrix.length,
      trimRowsMs: matrixDebug.trimRowsMs ?? null,
      selectedPlatform: "unity",
      detectedParser: unityStaircaseParserName,
      detectedColumns: "A:F",
      checkboxColumn: fixedGoogleSheetCheckboxColumnLetter,
      checkboxColumnIndex: fixedGoogleSheetCheckboxColumnIndex,
      descriptionColumn: "H",
      parameterDescriptionColumn: "I",
      headerRowIndex,
      headerRowNumber: headerRowIndex === null ? null : headerRowIndex + 1,
      meaningfulRowCount: candidates.length,
      importedSpecRowsCount: rows.length,
      specRowCount: rows.length,
      firstParsedEvents,
    },
  };
}

function normalizeValuesCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  const text = String(value).trim();
  if (!text) return "";
  return text.replace(/\s+/g, " ");
}

function buildMatrixFromValues(values: unknown): {
  matrix: string[][];
  checkboxMatrix: boolean[][];
} {
  const rows = Array.isArray(values)
    ? values.filter((row): row is unknown[] => Array.isArray(row))
    : [];
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);

  const matrix = rows.map((row) => {
    const next: string[] = [];
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex++) {
      next.push(normalizeValuesCell(row[columnIndex]));
    }
    return next;
  });
  const checkboxMatrix = rows.map((row) => {
    const next: boolean[] = [];
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex++) {
      next.push(typeof row[columnIndex] === "boolean");
    }
    return next;
  });

  return { matrix, checkboxMatrix };
}

function escapeCsvCell(value: string): string {
  if (!/[",\r\n]/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

function matrixToCsvText(matrix: string[][]): string {
  return matrix.map((row) => row.map(escapeCsvCell).join(",")).join("\r\n");
}

function buildValuesImportRange(sheetTitle: string): string {
  const trimmedTitle = sheetTitle.trim();
  if (/^[A-Za-z0-9_]+$/.test(trimmedTitle)) {
    return `${trimmedTitle}!A:I`;
  }
  return `'${trimmedTitle.replace(/'/g, "''")}'!A:I`;
}

function googleSheetImportErrorForStatus(status: number): string {
  if (status === 401) return googleSheetConnectionExpiredError;
  if (status === 403) return googleSheetAccessDeniedError;
  if (status === 404) return googleSheetNotFoundError;
  return googleSheetImportError;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function getErrorObjectProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || !(key in value)) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function getErrorPropertyText(value: unknown, key: string): string | null {
  const property = getErrorObjectProperty(value, key);
  if (typeof property === "string" && property.trim()) {
    return property.trim();
  }
  if (typeof property === "number") {
    return String(property);
  }
  return null;
}

function getErrorCauseCode(error: unknown): string | null {
  return getErrorPropertyText(getErrorObjectProperty(error, "cause"), "code");
}

function getValuesGetNetworkErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const causeMessage = getErrorPropertyText(
    getErrorObjectProperty(error, "cause"),
    "message",
  );
  const causeCode = getErrorCauseCode(error);
  return [message, causeCode, causeMessage].filter(Boolean).join(" ");
}

function isRetryableValuesGetNetworkError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  const detail = getValuesGetNetworkErrorMessage(error);
  return (
    isAbortError(error) ||
    name === "TimeoutError" ||
    /fetch failed|network|timed out|timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ABORT_ERR/i.test(
      detail,
    )
  );
}

function buildGoogleSheetImportResultFromMatrix(options: {
  matrix: string[][];
  checkboxMatrix: boolean[][];
  matrixDebug: GoogleSheetImportMatrix["debug"];
  matrixSource: GoogleSheetImportMatrix["source"];
  matrixSheetTitle: string | null;
  spreadsheetId: string;
  gid: string;
  sourceUrl: string;
  manualSheetTitle: string | null;
  selectedPlatform: GoogleSheetImportPlatform;
  sourceFileName: string;
  workbookText: string;
  importFetchMs?: number | null;
  googleRowsRead?: number | null;
  totalStartedAt?: number | null;
}): {
  result: ParsedSpecResult;
  fileName: string;
} {
  const preparedMatrix =
    options.selectedPlatform === "unity"
      ? trimUnityStaircaseMatrix(options.matrix, options.checkboxMatrix)
      : ({
          matrix: options.matrix,
          checkboxMatrix: options.checkboxMatrix,
          effectiveRowsParsed: options.matrix.length,
          trimRowsMs: null,
        } satisfies PreparedGoogleSheetImportMatrix);
  const fixedCheckboxMatrix = buildFixedGoogleSheetCheckboxMatrix(
    preparedMatrix.matrix,
    preparedMatrix.checkboxMatrix,
  );
  const importMatrix: GoogleSheetImportMatrix = {
    matrix: preparedMatrix.matrix,
    checkboxMatrix: fixedCheckboxMatrix,
    source: options.matrixSource,
    sheetTitle: options.matrixSheetTitle,
    debug: {
      ...options.matrixDebug,
      googleRowsRead:
        options.googleRowsRead ?? options.matrixDebug.matrixRowCount,
      effectiveRowsParsed: preparedMatrix.effectiveRowsParsed,
      trimRowsMs: preparedMatrix.trimRowsMs,
      importFetchMs: options.importFetchMs ?? null,
    },
  };
  const detectedColumns = detectGoogleSheetColumns(
    importMatrix.matrix,
    importMatrix.checkboxMatrix,
  );
  console.log(
    "[googleSheetImportPerf] metadataMs=0 skipped=fixedCheckboxAndManualTitle",
  );
  console.log("[googleSheetImportPerf] checkboxDetectionMs=0 skipped=fixedG");
  console.log(
    "[googleSheetImportPerf] sheetTitleResolveMs=0 skipped=manualOrBackground",
  );

  const importCheckboxColumnIndex = fixedGoogleSheetCheckboxColumnIndex;
  const checkboxColumnIndex = fixedGoogleSheetCheckboxColumnIndex;
  const statusColumnIndex = null;
  const resolvedSheetTitle =
    options.manualSheetTitle ?? importMatrix.sheetTitle;
  const fileName = googleSheetDisplayName(resolvedSheetTitle, options.gid);
  const parseStartedAt = Date.now();
  const importSource = {
    fileName,
    fileSize: Buffer.byteLength(options.workbookText, "utf8"),
  };
  let result =
    options.selectedPlatform === "unity"
      ? importUnityStaircaseSpecFromMatrix(
          importMatrix.matrix,
          importMatrix.checkboxMatrix,
          importSource,
          importMatrix.debug,
        )
      : importSpecFromMatrix(
          importMatrix.matrix,
          importMatrix.checkboxMatrix,
          importSource,
          { checkColumnIndex: importCheckboxColumnIndex },
          importMatrix.debug,
        );
  const importParseMs = logGoogleSheetImportPerf("parse", parseStartedAt);
  if (options.selectedPlatform === "unity") {
    console.log(
      `[unityParser] parseMs=${importParseMs} parsedRows=${result.rows.length}`,
    );
  }

  result = {
    ...result,
    rows: result.rows.map((row) => {
      const sourceRowNumber = getSourceRowNumber(row);
      const googleCheckRange =
        sourceRowNumber === null
          ? null
          : buildGoogleCheckRange(resolvedSheetTitle, sourceRowNumber);
      return {
        ...row,
        meta: {
          ...(row.meta ?? {}),
          eventName: getRowEventName(row),
          normalizedEventName: normalizeGoogleSheetEventName(
            getRowEventName(row),
          ),
          googleCheckRange,
        },
      };
    }),
  };

  const fixedCheckboxCount = countFixedGoogleSheetCheckboxRows(
    importMatrix.checkboxMatrix,
  );
  const parserHeaderRowIndex =
    typeof result.debug.headerRowIndex === "number" &&
    Number.isInteger(result.debug.headerRowIndex)
      ? result.debug.headerRowIndex
      : null;
  const metadataHeaderRowIndex =
    parserHeaderRowIndex ?? detectedColumns.headerRowIndex;
  const metadataHeaders =
    metadataHeaderRowIndex === null
      ? detectedColumns.headers
      : [...(importMatrix.matrix[metadataHeaderRowIndex] ?? [])];
  const sourceMetadata: GoogleSheetSourceMetadata = {
    spreadsheetId: options.spreadsheetId,
    gid: options.gid,
    sourceUrl: options.sourceUrl,
    selectedPlatform: options.selectedPlatform,
    detectedParser:
      typeof result.debug.detectedParser === "string"
        ? result.debug.detectedParser
        : options.selectedPlatform === "unity"
          ? unityStaircaseParserName
          : "default-staircase",
    detectedColumns:
      typeof result.debug.detectedColumns === "string"
        ? result.debug.detectedColumns
        : options.selectedPlatform === "unity"
          ? "A:F"
          : null,
    checkboxColumn: fixedGoogleSheetCheckboxColumnLetter,
    descriptionColumn:
      typeof result.debug.descriptionColumn === "string"
        ? result.debug.descriptionColumn
        : null,
    parameterDescriptionColumn:
      typeof result.debug.parameterDescriptionColumn === "string"
        ? result.debug.parameterDescriptionColumn
        : null,
    importedSpecRowsCount: result.rows.length,
    firstParsedEvents: result.rows
      .slice(0, 20)
      .map((row) => getRowEventName(row))
      .filter(Boolean),
    importFetchMs: options.importFetchMs ?? null,
    importParseMs,
    importTotalMs:
      options.totalStartedAt === null || options.totalStartedAt === undefined
        ? null
        : Date.now() - options.totalStartedAt,
    googleRowsRead: options.googleRowsRead ?? options.matrix.length,
    effectiveRowsParsed: preparedMatrix.effectiveRowsParsed,
    sheetTitle: resolvedSheetTitle,
    manualSheetTitle: options.manualSheetTitle ?? resolvedSheetTitle,
    sheetTitleResolutionError: resolvedSheetTitle
      ? null
      : unresolvedTabMessage(options.gid),
    checkboxColumnIndex,
    statusColumnIndex,
    checkboxCandidates: [
      {
        columnIndex: fixedGoogleSheetCheckboxColumnIndex,
        count: fixedCheckboxCount,
        dataValidationCount: 0,
        boolValueCount: fixedCheckboxCount,
        header:
          detectedColumns.headers[fixedGoogleSheetCheckboxColumnIndex] ??
          fixedGoogleSheetCheckboxColumnLetter,
      },
    ],
    checkboxColumnDetectionError: null,
    checkboxColumnSource: "fixed",
    detectedHeaders: metadataHeaders,
    headerRowIndex: metadataHeaderRowIndex,
    headerRowNumber:
      metadataHeaderRowIndex === null
        ? null
        : metadataHeaderRowIndex + 1,
    doneColumnIndex: checkboxColumnIndex,
    checkColumnIndex: statusColumnIndex,
    rows: buildSourceRows(result.rows, resolvedSheetTitle),
    staircaseRows:
      options.selectedPlatform === "unity"
        ? []
        : buildStaircaseRows(importMatrix.matrix),
  };

  console.log(
    `[googleSheetImport] sheetTitleResolutionError=${
      sourceMetadata.sheetTitleResolutionError ?? "null"
    }`,
  );
  console.log(`[googleSheetImport] checkboxColumnIndex=${checkboxColumnIndex}`);
  console.log(`[googleSheetImport] statusColumnIndex=${statusColumnIndex}`);
  console.log(
    `[googleSheetImport] checkboxColumnDetectionError=${
      sourceMetadata.checkboxColumnDetectionError ?? "null"
    }`,
  );
  console.log(`[googleSheetImport] mappedRows=${sourceMetadata.rows.length}`);
  console.log(`[googleSheetImport] sourceRowMappingSource=${importMatrix.source}`);

  result = {
    ...result,
    debug: {
      ...result.debug,
      fileName,
      selectedPlatform: options.selectedPlatform,
      importFetchMs: options.importFetchMs ?? null,
      importParseMs,
      importTotalMs:
        options.totalStartedAt === null || options.totalStartedAt === undefined
          ? null
          : Date.now() - options.totalStartedAt,
      googleRowsRead: options.googleRowsRead ?? options.matrix.length,
      effectiveRowsParsed: preparedMatrix.effectiveRowsParsed,
      sourceRowMappingSource: importMatrix.source,
      sourceGoogleSheetCsvFileName: options.sourceFileName,
      sourceGoogleSheet: sourceMetadata,
    },
  };

  return { result, fileName };
}

function fetchGoogleSheetValuesWithHttpsFallback(
  url: string,
  accessToken: string,
): Promise<ValuesGetTransportResult> {
  console.log("[googleSheetImport] values.get https fallback start");
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    const resolveOnce = (result: ValuesGetTransportResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const fail = (error: unknown) => {
      const diagnostics = getErrorDiagnostics(error);
      console.log(
        `[googleSheetImport] values.get https fallback failed error=${diagnostics.message}`,
      );
      resolveOnce({
        success: false,
        error: googleSheetImportError,
        status: 502,
        technicalDetail: diagnostics.message,
        errorMessage: diagnostics.message,
      });
    };
    const request = httpsGet(
      url,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "user-agent": "AnalyticsChecker/1.0",
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const statusText = response.statusMessage ?? "";
        const contentType =
          getHeader(response.headers, "content-type") || "application/json";
        console.log(
          `[googleSheetImport] values.get https fallback status=${status}`,
        );

        response.setEncoding("utf8");
        const chunks: string[] = [];

        response.on("error", fail);

        response.on("data", (chunk: string) => {
          chunks.push(chunk);
        });

        response.on("end", () => {
          resolveOnce({
            success: true,
            transport: "https fallback",
            status,
            statusText,
            contentType,
            text: chunks.join(""),
            durationMs: Date.now() - startedAt,
          });
        });
      },
    );

    request.on("error", fail);
  });
}

async function fetchGoogleSheetValuesMatrix(options: {
  spreadsheetId: string;
  sheetTitle: string;
}): Promise<
  | {
      success: true;
      endpoint: CsvEndpoint;
      matrix: string[][];
      checkboxMatrix: boolean[][];
      debug: GoogleSheetImportMatrix["debug"];
      csvText: string;
      contentType: string;
      status: number;
      statusText: string;
      sourceTransport: "values.get" | "https fallback";
      valuesFetchMs: number;
      rowsRead: number;
      range: string;
    }
  | ValuesGetFailure
> {
  const range = buildValuesImportRange(options.sheetTitle);
  const startedAt = Date.now();
  console.log(`[googleSheetImport] values.get start range=${range}`);

  let accessToken = "";
  try {
    accessToken = await getGoogleSheetsAccessToken();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof GoogleOAuthReconnectRequiredError) {
      console.log(
        `[googleSheetImport] values.get failed status=401 error=${message}`,
      );
      return {
        success: false,
        error: googleSheetConnectionExpiredError,
        status: 401,
        technicalDetail: message,
        errorMessage: message,
      };
    }
    if (error instanceof GoogleOAuthMisconfiguredError) {
      console.log(
        `[googleSheetImport] values.get failed status=401 error=${message}`,
      );
      return {
        success: false,
        error: googleOAuthMisconfiguredError,
        status: 401,
        technicalDetail: message,
        errorMessage: message,
      };
    }
    if (error instanceof GoogleOAuthNetworkError) {
      console.log(
        `[googleSheetImport] values.get failed status=network error=${message}`,
      );
      return {
        success: false,
        error: /Google OAuth is taking too long/i.test(message)
          ? googleOAuthTimeoutError
          : googleSheetImportError,
        status: 502,
        technicalDetail: error.technicalDetail ?? message,
        errorMessage: error.technicalDetail ?? message,
      };
    }
    console.log(
      `[googleSheetImport] values.get failed status=401 error=${message}`,
    );
    return {
      success: false,
      error: googleSheetConnectionExpiredError,
      status: 401,
      technicalDetail: message,
      errorMessage: message,
    };
  }

  const endpoint: CsvEndpoint = {
    name: "values.get",
    url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      options.spreadsheetId,
    )}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`,
  };
  let valuesResponse: ValuesGetHttpResponse;
  const fetchStartedAt = Date.now();
  try {
    console.log(
      "[googleSheetImport] values.get fetch start urlHost=sheets.googleapis.com timeoutMs=none",
    );
    const response = await fetch(endpoint.url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    const status = response.status;
    const statusText = response.statusText;
    const contentType =
      response.headers.get("content-type") ?? "application/json";
    console.log(`[googleSheetImport] values.get status=${status}`);
    const text = await response.text();
    valuesResponse = {
      success: true,
      transport: "fetch",
      status,
      statusText,
      contentType,
      text,
      durationMs: Date.now() - fetchStartedAt,
    };
  } catch (error) {
    const diagnostics = getErrorDiagnostics(error);
    const message = diagnostics.message;
    console.log(
      `[googleSheetImport] values.get fetch failed error=${message}`,
    );
    if (!isRetryableValuesGetNetworkError(error)) {
      return {
        success: false,
        error: message,
        status: 502,
        technicalDetail: diagnostics.message,
        errorMessage: diagnostics.message,
      };
    }
    const fallbackResponse = await fetchGoogleSheetValuesWithHttpsFallback(
      endpoint.url,
      accessToken,
    );
    if (!fallbackResponse.success) {
      return fallbackResponse;
    }
    valuesResponse = fallbackResponse;
  }

  const { status, statusText, contentType, text, transport, durationMs } =
    valuesResponse;

  if (status < 200 || status >= 300) {
    let apiMessage = text.trim();
    try {
      const payload = JSON.parse(text) as {
        error?: { message?: string };
      };
      apiMessage = payload.error?.message ?? apiMessage;
    } catch {
      // Keep raw response text for diagnostics.
    }
    const error = googleSheetImportErrorForStatus(status);
    console.log(
      `[googleSheetImport] values.get failed status=${status} error=${apiMessage}`,
    );
    if (transport === "https fallback") {
      console.log(
        `[googleSheetImport] values.get https fallback failed error=${apiMessage}`,
      );
    }
    return {
      success: false,
      error,
      status: [401, 403, 404].includes(status) ? status : 502,
      responseStatus: status,
      statusText,
      technicalDetail: apiMessage,
      errorMessage: apiMessage,
    };
  }

  let payload: { values?: unknown };
  try {
    payload = JSON.parse(text) as { values?: unknown };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(
      `[googleSheetImport] values.get failed status=${status} error=${message}`,
    );
    if (transport === "https fallback") {
      console.log(
        `[googleSheetImport] values.get https fallback failed error=${message}`,
      );
    }
    return {
      success: false,
      error: `Google Sheets API response parse failed: ${message}`,
      status: 502,
      responseStatus: status,
      statusText,
      technicalDetail: message,
      errorMessage: message,
    };
  }

  const { matrix, checkboxMatrix } = buildMatrixFromValues(payload.values);
  if (matrix.length === 0) {
    const error = "Google Sheets API returned empty values";
    console.log(
      `[googleSheetImport] values.get failed status=${status} error=${error}`,
    );
    if (transport === "https fallback") {
      console.log(
        `[googleSheetImport] values.get https fallback failed error=${error}`,
      );
    }
    return {
      success: false,
      error,
      status: 502,
      responseStatus: status,
      statusText,
      technicalDetail: error,
      errorMessage: error,
    };
  }

  const csvText = matrixToCsvText(matrix);
  console.log(
    `[googleSheetImport] values.get success rows=${matrix.length} durationMs=${
      Date.now() - startedAt
    }`,
  );
  console.log(
    `[googleSheetImport] valuesFetchMs=${durationMs} rowsRead=${matrix.length}`,
  );
  if (transport === "https fallback") {
    console.log(
      `[googleSheetImport] values.get https fallback success rows=${matrix.length} durationMs=${durationMs}`,
    );
  }
  return {
    success: true,
    endpoint,
    matrix,
    checkboxMatrix,
    debug: {
      sheetNames: [options.sheetTitle],
      usedSheetName: options.sheetTitle,
      matrixRowCount: matrix.length,
      matrixColCount: getMatrixColumnCount(matrix),
    },
    csvText,
    contentType,
    status,
    statusText,
    sourceTransport: transport === "https fallback" ? "https fallback" : "values.get",
    valuesFetchMs: durationMs,
    rowsRead: matrix.length,
    range,
  };
}

async function resolveGoogleSheetImportMatrix(
  spreadsheetId: string,
  gid: string,
  csvMatrix: GoogleSheetImportMatrix,
): Promise<GoogleSheetImportMatrix> {
  let accessToken = "";
  try {
    accessToken = await getGoogleSheetsAccessToken();
  } catch (error) {
    console.warn("[googleSheetImport] grid matrix token unavailable", {
      spreadsheetId,
      gid,
      error: error instanceof Error ? error.message : String(error),
    });
    return csvMatrix;
  }

  if (!accessToken) {
    console.warn("[googleSheetImport] grid matrix skipped: access token missing", {
      spreadsheetId,
      gid,
    });
    return csvMatrix;
  }

  try {
    const gridMatrix = await fetchGoogleSheetGridMatrix(
      spreadsheetId,
      gid,
      accessToken,
    );
    console.log(
      `[googleSheetImport] sourceRowMappingSource=googleGrid matrixRows=${gridMatrix.matrixRowCount} matrixCols=${gridMatrix.matrixColCount}`,
    );
    return {
      matrix: gridMatrix.matrix,
      checkboxMatrix: gridMatrix.checkboxMatrix,
      source: "googleGrid",
      sheetTitle: gridMatrix.sheetTitle,
      debug: {
        sheetNames: gridMatrix.sheetTitle ? [gridMatrix.sheetTitle] : [],
        usedSheetName: gridMatrix.sheetTitle ?? "",
        matrixRowCount: gridMatrix.matrixRowCount,
        matrixColCount: gridMatrix.matrixColCount,
      },
    };
  } catch (error) {
    console.warn("[googleSheetImport] grid matrix fallback to csv", {
      spreadsheetId,
      gid,
      error: error instanceof Error ? error.message : String(error),
    });
    return csvMatrix;
  }
}

function unresolvedTabMessage(gid: string): string {
  return `Could not resolve tab name for gid=${gid}. Re-import Google Sheet after Google connection.`;
}

function googleSheetDisplayName(sheetTitle: string | null, gid: string): string {
  const title = sheetTitle?.trim();
  return title ? `Google Sheet: ${title}` : `Google Sheet gid=${gid}`;
}

async function resolveSheetTitleForImport(
  spreadsheetId: string,
  gid: string,
): Promise<{ sheetTitle: string | null; error: string | null }> {
  console.log(`[googleSheetImport] spreadsheetId=${spreadsheetId}`);
  console.log(`[googleSheetImport] gid=${gid}`);
  let accessToken = "";
  try {
    accessToken = await getGoogleSheetsAccessToken();
  } catch (error) {
    const tokenError =
      error instanceof GoogleOAuthNetworkError
        ? error.technicalDetail ?? error.message
        : null;
    console.log("[googleSheetImport] accessTokenExists=false");
    console.log("[googleSheetImport] resolvedSheetTitle=null");
    console.log(
      `[googleSheetImport] sheetTitleResolutionError=${tokenError ?? "null"}`,
    );
    console.warn("[googleSheetImport] sheet title was not resolved", {
      spreadsheetId,
      gid,
      error: error instanceof Error ? error.message : String(error),
    });
    return { sheetTitle: null, error: tokenError };
  }

  console.log(`[googleSheetImport] accessTokenExists=${accessToken.length > 0}`);
  if (!accessToken) {
    console.log("[googleSheetImport] resolvedSheetTitle=null");
    console.log("[googleSheetImport] sheetTitleResolutionError=null");
    return { sheetTitle: null, error: null };
  }

  try {
    const sheetTitle = await resolveGoogleSheetTitle(
      spreadsheetId,
      gid,
      accessToken,
    );
    console.log(`[googleSheetImport] resolvedSheetTitle=${sheetTitle}`);
    console.log("[googleSheetImport] sheetTitleResolutionError=null");
    return { sheetTitle, error: null };
  } catch (error) {
    const resolutionError =
      error instanceof GoogleSheetSyncError
        ? error.technicalDetail ?? error.message
        : error instanceof Error
          ? error.message
          : unresolvedTabMessage(gid);
    console.log("[googleSheetImport] resolvedSheetTitle=null");
    console.log(`[googleSheetImport] sheetTitleResolutionError=${resolutionError}`);
    console.warn("[googleSheetImport] sheet title was not resolved", {
      spreadsheetId,
      gid,
      error: error instanceof Error ? error.message : String(error),
    });
    return { sheetTitle: null, error: resolutionError };
  }
}

async function resolveCheckboxColumnsForImport(
  spreadsheetId: string,
  gid: string,
  headers: string[],
  preferredColumnIndex: number | null,
  rowNumbers: number[],
): Promise<{
  checkboxColumnIndex: number | null;
  checkboxCandidates: GoogleSheetCheckboxCandidate[];
  checkboxColumnDetectionError: string | null;
}> {
  try {
    const accessToken = await getGoogleSheetsAccessToken();
    return await resolveGoogleSheetCheckboxColumns(
      spreadsheetId,
      gid,
      accessToken,
      {
        headers,
        preferredColumnIndex,
        rowNumbers,
      },
    );
  } catch (error) {
    const message =
      error instanceof GoogleSheetSyncError
        ? error.technicalDetail ?? error.message
        : error instanceof Error
          ? error.message
          : "Checkbox column not found";
    console.warn("[googleSheetColumns] metadata detection failed", {
      spreadsheetId,
      gid,
      error: message,
    });
    return {
      checkboxColumnIndex: null,
      checkboxCandidates: [],
      checkboxColumnDetectionError: message,
    };
  }
}

function buildTechnicalDetail(options: {
  endpoint: CsvEndpoint;
  transport?: "global fetch" | "https fallback";
  responseStatus?: number;
  contentType?: string;
  errorMessage?: string;
  globalFetchError?: string;
  fallbackError?: string;
}) {
  const parts = [`used endpoint=${options.endpoint.name}`];

  if (options.transport) {
    parts.push(`transport=${options.transport}`);
  }

  if (typeof options.responseStatus === "number") {
    parts.push(`HTTP ${options.responseStatus}`);
  }

  if (options.contentType) {
    parts.push(`content-type=${options.contentType}`);
  }

  if (options.errorMessage) {
    parts.push(`error.message=${options.errorMessage}`);
  }

  if (options.globalFetchError) {
    parts.push(`global fetch failed: ${options.globalFetchError}`);
  }

  if (options.fallbackError) {
    parts.push(`fallback failed: ${options.fallbackError}`);
  }

  return `(${parts.join("; ")})`;
}

function attachGoogleSheetImportTotalMs(
  result: ParsedSpecResult,
  importTotalMs: number,
): ParsedSpecResult {
  const sourceGoogleSheet = result.debug.sourceGoogleSheet;
  const nextSourceGoogleSheet =
    sourceGoogleSheet && typeof sourceGoogleSheet === "object"
      ? {
          ...(sourceGoogleSheet as Record<string, unknown>),
          importTotalMs,
        }
      : sourceGoogleSheet;
  return {
    ...result,
    debug: {
      ...result.debug,
      importTotalMs,
      sourceGoogleSheet: nextSourceGoogleSheet,
    },
  };
}

function summarizeAttempt(attempt: CsvDownloadAttempt): string {
  if (attempt.success) {
    return `${attempt.endpoint.name}/${attempt.transport}: HTTP ${attempt.status}; content-type=${attempt.contentType || "unknown"}`;
  }

  return `${attempt.endpoint.name}: ${attempt.error} ${attempt.technicalDetail}`;
}

type HttpsTextResponse = {
  status: number;
  statusText: string;
  headers: IncomingHttpHeaders;
  text: string;
  finalUrl: string;
};

function getHeader(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(", ");
  return value ?? "";
}

function httpsGetText(
  url: string,
  redirectCount = 0,
): Promise<HttpsTextResponse> {
  return new Promise((resolve, reject) => {
    const request = httpsGet(
      url,
      {
        headers: {
          "user-agent": "AnalyticsChecker/1.0",
          accept: "text/csv,text/plain,*/*",
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const statusText = response.statusMessage ?? "";
        const location = response.headers.location;
        const isRedirect = [301, 302, 303, 307, 308].includes(status);

        if (isRedirect && location) {
          response.resume();

          if (redirectCount >= httpsRedirectLimit) {
            reject(
              new Error(
                `https fallback exceeded ${httpsRedirectLimit} redirects`,
              ),
            );
            return;
          }

          let nextUrl: URL;
          try {
            nextUrl = new URL(location, url);
          } catch (error) {
            reject(error);
            return;
          }

          if (nextUrl.protocol !== "https:") {
            reject(
              new Error(
                `https fallback refused non-https redirect: ${nextUrl.protocol}`,
              ),
            );
            return;
          }

          resolve(httpsGetText(nextUrl.toString(), redirectCount + 1));
          return;
        }

        response.setEncoding("utf8");
        const chunks: string[] = [];

        response.on("error", reject);

        response.on("data", (chunk: string) => {
          chunks.push(chunk);
        });

        response.on("end", () => {
          resolve({
            status,
            statusText,
            headers: response.headers,
            text: chunks.join(""),
            finalUrl: url,
          });
        });
      },
    );

    request.on("error", reject);
  });
}

function buildCsvAttemptFromText(options: {
  endpoint: CsvEndpoint;
  transport: "global fetch" | "https fallback";
  status: number;
  statusText: string;
  contentType: string;
  contentDisposition: string | null;
  text: string;
  globalFetchError?: string;
}): CsvDownloadAttempt {
  const textLength = options.text.length;
  const isOk = options.status >= 200 && options.status < 300;

  if (!isOk) {
    const error = `Google export failed: HTTP ${options.status}`;
    return {
      success: false,
      endpoint: options.endpoint,
      transport: options.transport,
      error,
      status: 502,
      responseStatus: options.status,
      statusText: options.statusText,
      contentType: options.contentType,
      textLength,
      technicalDetail: buildTechnicalDetail({
        endpoint: options.endpoint,
        transport: options.transport,
        responseStatus: options.status,
        contentType: options.contentType,
        errorMessage: error,
        globalFetchError: options.globalFetchError,
      }),
      errorMessage: error,
      globalFetchError: options.globalFetchError,
    };
  }

  if (
    looksLikeHtml(options.text) ||
    options.contentType.toLowerCase().includes("text/html")
  ) {
    const error = "Google returned HTML instead of CSV";
    return {
      success: false,
      endpoint: options.endpoint,
      transport: options.transport,
      error,
      status: 502,
      responseStatus: options.status,
      statusText: options.statusText,
      contentType: options.contentType,
      textLength,
      technicalDetail: buildTechnicalDetail({
        endpoint: options.endpoint,
        transport: options.transport,
        responseStatus: options.status,
        contentType: options.contentType,
        errorMessage: error,
        globalFetchError: options.globalFetchError,
      }),
      errorMessage: error,
      globalFetchError: options.globalFetchError,
    };
  }

  if (options.text.trim().length === 0) {
    const error = "Google returned empty CSV";
    return {
      success: false,
      endpoint: options.endpoint,
      transport: options.transport,
      error,
      status: 502,
      responseStatus: options.status,
      statusText: options.statusText,
      contentType: options.contentType,
      textLength,
      technicalDetail: buildTechnicalDetail({
        endpoint: options.endpoint,
        transport: options.transport,
        responseStatus: options.status,
        contentType: options.contentType,
        errorMessage: error,
        globalFetchError: options.globalFetchError,
      }),
      errorMessage: error,
      globalFetchError: options.globalFetchError,
    };
  }

  return {
    success: true,
    endpoint: options.endpoint,
    transport: options.transport,
    csvText: options.text,
    contentType: options.contentType,
    contentDisposition: options.contentDisposition,
    status: options.status,
    statusText: options.statusText,
  };
}

async function fetchCsvWithHttpsFallback(
  endpoint: CsvEndpoint,
  globalFetchError: string,
): Promise<CsvDownloadAttempt> {
  console.log("[google-sheet-import] trying https fallback", {
    endpoint: endpoint.name,
    url: endpoint.url,
    globalFetchError,
  });

  try {
    const response = await httpsGetText(endpoint.url);
    return buildCsvAttemptFromText({
      endpoint,
      transport: "https fallback",
      status: response.status,
      statusText: response.statusText,
      contentType: getHeader(response.headers, "content-type"),
      contentDisposition: getHeader(response.headers, "content-disposition"),
      text: response.text,
      globalFetchError,
    });
  } catch (error) {
    const diagnostics = getErrorDiagnostics(error);
    const fallbackError = diagnostics.message;
    console.error("[google-sheet-import] https fallback exception", {
      endpoint: endpoint.name,
      url: endpoint.url,
      globalFetchError,
      ...diagnostics,
    });

    return {
      success: false,
      endpoint,
      transport: "https fallback",
      error: `Google Sheet fetch failed: global fetch failed: ${globalFetchError}; fallback failed: ${fallbackError}`,
      status: 502,
      technicalDetail: buildTechnicalDetail({
        endpoint,
        transport: "https fallback",
        errorMessage: fallbackError,
        globalFetchError,
        fallbackError,
      }),
      errorMessage: fallbackError,
      globalFetchError,
      fallbackError,
    };
  }
}

async function fetchCsvEndpoint(
  endpoint: CsvEndpoint,
): Promise<CsvDownloadAttempt> {
  console.log("[google-sheet-import] fetching CSV", {
    endpoint: endpoint.name,
    url: endpoint.url,
  });

  let response: Response;
  try {
    response = await fetch(endpoint.url, {
      redirect: "follow",
    });
  } catch (error) {
    const diagnostics = getErrorDiagnostics(error);
    console.error("[google-sheet-import] fetch exception", {
      endpoint: endpoint.name,
      url: endpoint.url,
      ...diagnostics,
    });

    return fetchCsvWithHttpsFallback(endpoint, diagnostics.message);
  }

  const contentType = response.headers.get("content-type") ?? "";
  let text = "";
  try {
    text = await response.text();
  } catch (error) {
    const diagnostics = getErrorDiagnostics(error);
    console.error("[google-sheet-import] response text exception", {
      endpoint: endpoint.name,
      url: endpoint.url,
      status: response.status,
      contentType,
      ...diagnostics,
    });

      return fetchCsvWithHttpsFallback(endpoint, diagnostics.message);
  }

  return buildCsvAttemptFromText({
    endpoint,
    transport: "global fetch",
    status: response.status,
    statusText: response.statusText,
    contentType,
    contentDisposition: response.headers.get("content-disposition"),
    text,
  });
}

export async function POST(request: Request) {
  let rawUrl = "";
  let sheetId: string | null = null;
  let gid: string | null = null;
  let manualSheetTitle: string | null = null;
  let fallbackSheetTitle: string | null = null;
  let selectedPlatform: GoogleSheetImportPlatform = "android";
  const totalStartedAt = Date.now();
  const fastImportStartedAt = totalStartedAt;

  try {
    const body: unknown = await request.json().catch(() => null);
    const urlParseStartedAt = Date.now();
    console.log("[googleSheetImport] import start noGlobalTimeout=true");
    console.log("[googleSheetImportPerf] importFlowTimeoutMs=none");
    console.log("[googleSheetImportPerf] transportTimeoutMs=none");
    rawUrl =
      body &&
      typeof body === "object" &&
      "url" in body &&
      typeof body.url === "string"
        ? body.url
        : "";
    manualSheetTitle =
      body &&
      typeof body === "object" &&
      "manualSheetTitle" in body &&
      typeof body.manualSheetTitle === "string"
        ? body.manualSheetTitle.trim() || null
        : null;
    fallbackSheetTitle =
      body &&
      typeof body === "object" &&
      "fallbackSheetTitle" in body &&
      typeof body.fallbackSheetTitle === "string"
        ? body.fallbackSheetTitle.trim() || null
        : null;
    selectedPlatform =
      body && typeof body === "object"
        ? parseGoogleSheetImportPlatform(
            "selectedPlatform" in body
              ? body.selectedPlatform
              : "platform" in body
                ? body.platform
                : null,
          )
        : "android";
    sheetId = extractSheetId(rawUrl);
    gid = extractGid(rawUrl);
    logGoogleSheetImportPerf("urlParse", urlParseStartedAt);

    if (!sheetId) {
      return googleSheetImportFailure(
        "Invalid Google Sheet URL: sheetId not found.",
        400,
        { rawUrl },
      );
    }

    if (!gid) {
      return googleSheetImportFailure(
        "Could not determine sheet tab. Open the needed tab in Google Sheets and copy the full URL with gid.",
        400,
        { rawUrl, sheetId },
      );
    }

    const encodedSheetId = encodeURIComponent(sheetId);
    const encodedGid = encodeURIComponent(gid);
    const endpoints: CsvEndpoint[] = [
      {
        name: "export",
        url: `https://docs.google.com/spreadsheets/d/${encodedSheetId}/export?format=csv&gid=${encodedGid}`,
      },
      {
        name: "gviz fallback",
        url: `https://docs.google.com/spreadsheets/d/${encodedSheetId}/gviz/tq?tqx=out:csv&gid=${encodedGid}`,
      },
    ];
    const attempts: CsvDownloadAttempt[] = [];
    let finalFailure: CsvDownloadFailure | null = null;
    let valuesFailure: ValuesGetFailure | null = null;
    let successfulEndpoint: CsvEndpoint | null = null;
    let successfulContentType = "";
    let successfulStatus = 0;
    let workbookText = "";
    let result: ParsedSpecResult | null = null;
    let fileName = "";
    let valuesPrimaryAttempted = false;

    if (selectedPlatform === "unity") {
      const valuesSheetTitle =
        manualSheetTitle ?? fallbackSheetTitle ?? "Analytics_Unity";
      const unityRange = buildValuesImportRange(valuesSheetTitle);
      console.log(`[googleSheetImport] platform=unity range=${unityRange}`);
      const valuesPrimaryStartedAt = Date.now();
      console.log("[googleSheetImport] values.get unity primary start");
      valuesPrimaryAttempted = true;
      const valuesAttempt = await fetchGoogleSheetValuesMatrix({
        spreadsheetId: sheetId,
        sheetTitle: valuesSheetTitle,
      });
      if (valuesAttempt.success) {
        try {
          const built = buildGoogleSheetImportResultFromMatrix({
            matrix: valuesAttempt.matrix,
            checkboxMatrix: valuesAttempt.checkboxMatrix,
            matrixDebug: valuesAttempt.debug,
            matrixSource: "valuesApi",
            matrixSheetTitle: valuesSheetTitle,
            spreadsheetId: sheetId,
            gid,
            sourceUrl: rawUrl.trim(),
            manualSheetTitle: valuesSheetTitle,
            selectedPlatform,
            sourceFileName: googleSheetDisplayName(valuesSheetTitle, gid),
            workbookText: valuesAttempt.csvText,
            importFetchMs: valuesAttempt.valuesFetchMs,
            googleRowsRead: valuesAttempt.rowsRead,
            totalStartedAt,
          });
          result = built.result;
          fileName = built.fileName;
          successfulEndpoint = valuesAttempt.endpoint;
          successfulContentType = valuesAttempt.contentType;
          successfulStatus = valuesAttempt.status;
          workbookText = valuesAttempt.csvText;
          console.log(
            `[googleSheetImport] values.get unity primary success rows=${valuesAttempt.matrix.length} durationMs=${
              Date.now() - valuesPrimaryStartedAt
            }`,
          );
          console.log(
            `[googleSheetImportPerf] source=${
              valuesAttempt.sourceTransport ?? "values.get"
            }`,
          );
          valuesFailure = null;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          valuesFailure = {
            success: false,
            error: `Google Sheets API import failed: ${message}`,
            status: 422,
            responseStatus: valuesAttempt.status,
            statusText: valuesAttempt.statusText,
            technicalDetail: message,
            errorMessage: message,
          };
          console.error("[google-sheet-import] values.get unity import failed", {
            sheetId,
            gid,
            endpoint: valuesAttempt.endpoint.name,
            url: valuesAttempt.endpoint.url,
            status: valuesAttempt.status,
            contentType: valuesAttempt.contentType,
            error: message,
          });
          console.log(
            `[googleSheetImport] values.get unity primary failed error=${message}`,
          );
        }
      } else {
        valuesFailure = valuesAttempt;
        console.log(
          `[googleSheetImport] values.get unity primary failed error=${valuesAttempt.error}`,
        );
      }
    }

    const csvPrimaryStartedAt = Date.now();
    if (!result) {
      console.log("[googleSheetImport] csv primary start");
    }
    for (const endpoint of result ? [] : endpoints) {
      const downloadStartedAt = Date.now();
      console.log("[googleSheetImportPerf] download start");
      const attempt = await fetchCsvEndpoint(endpoint);
      const downloadMs = logGoogleSheetImportPerf(
        "download",
        downloadStartedAt,
      );
      if (attempt.success) {
        console.log(
          `[googleSheetImportPerf] download success durationMs=${downloadMs}`,
        );
      } else {
        console.log(
          `[googleSheetImportPerf] download failed durationMs=${downloadMs} error=${attempt.error}`,
        );
        console.log(
          `[googleSheetImport] csv primary failed error=${attempt.error}`,
        );
      }
      console.log(
        `[googleSheetImportPerf] downloadEndpoint=${endpoint.name} success=${attempt.success} transport=${
          attempt.transport ?? "null"
        } durationMs=${downloadMs}`,
      );
      attempts.push(attempt);

      if (!attempt.success) {
        finalFailure = attempt;
        continue;
      }

      successfulEndpoint = attempt.endpoint;
      successfulContentType = attempt.contentType;
      successfulStatus = attempt.status;
      workbookText = attempt.csvText;

      try {
        const csvParseStartedAt = Date.now();
        const parsedCsvWorkbook = parseWorkbookToMatrix(attempt.csvText);
        logGoogleSheetImportPerf("csvParse", csvParseStartedAt);
        console.log(
          `[googleSheetImport] csv primary success rows=${parsedCsvWorkbook.matrix.length} durationMs=${
            Date.now() - csvPrimaryStartedAt
          }`,
        );
        const downloadedCsvFileName = getCsvFileName(
          attempt.contentDisposition,
          gid,
        );
        const built = buildGoogleSheetImportResultFromMatrix({
          matrix: parsedCsvWorkbook.matrix,
          checkboxMatrix: parsedCsvWorkbook.checkboxMatrix,
          matrixDebug: parsedCsvWorkbook.debug,
          matrixSource: "csv",
          matrixSheetTitle: manualSheetTitle,
          spreadsheetId: sheetId,
          gid,
          sourceUrl: rawUrl.trim(),
          manualSheetTitle,
          selectedPlatform,
          sourceFileName: downloadedCsvFileName,
          workbookText: attempt.csvText,
          importFetchMs: downloadMs,
          googleRowsRead: parsedCsvWorkbook.matrix.length,
          totalStartedAt,
        });
        result = built.result;
        fileName = built.fileName;
        console.log("[googleSheetImportPerf] source=csv");
        console.log(
          `[googleSheetImportPerf] totalImportMs=${Date.now() - totalStartedAt}`,
        );
        logGoogleSheetImportPerf("totalFastImport", fastImportStartedAt);
        logGoogleSheetImportPerf("total", totalStartedAt);
        finalFailure = null;
        break;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        finalFailure = {
          success: false,
          endpoint,
          error: `CSV import failed: ${message}`,
          status: 422,
          responseStatus: attempt.status,
          statusText: attempt.statusText,
          contentType: attempt.contentType,
          textLength: attempt.csvText.length,
          technicalDetail: buildTechnicalDetail({
            endpoint,
            responseStatus: attempt.status,
            contentType: attempt.contentType,
            errorMessage: message,
          }),
          errorMessage: message,
        };
        console.error("[google-sheet-import] CSV import failed", {
          sheetId,
          gid,
          endpoint: endpoint.name,
          url: endpoint.url,
          status: attempt.status,
          contentType: attempt.contentType,
          error: message,
        });
        console.log(`[googleSheetImport] csv primary failed error=${message}`);
      }
    }

    if (!result && !valuesPrimaryAttempted) {
      const valuesSheetTitle =
        manualSheetTitle ?? fallbackSheetTitle ?? "Analytics_GooglePlay";
      const valuesFallbackStartedAt = Date.now();
      console.log("[googleSheetImport] values.get fallback start");
      const valuesAttempt = await fetchGoogleSheetValuesMatrix({
        spreadsheetId: sheetId,
        sheetTitle: valuesSheetTitle,
      });
      if (valuesAttempt.success) {
        try {
          const built = buildGoogleSheetImportResultFromMatrix({
            matrix: valuesAttempt.matrix,
            checkboxMatrix: valuesAttempt.checkboxMatrix,
            matrixDebug: valuesAttempt.debug,
            matrixSource: "valuesApi",
            matrixSheetTitle: valuesSheetTitle,
            spreadsheetId: sheetId,
            gid,
            sourceUrl: rawUrl.trim(),
            manualSheetTitle: valuesSheetTitle,
            selectedPlatform,
            sourceFileName: googleSheetDisplayName(valuesSheetTitle, gid),
            workbookText: valuesAttempt.csvText,
            importFetchMs: valuesAttempt.valuesFetchMs,
            googleRowsRead: valuesAttempt.rowsRead,
            totalStartedAt,
          });
          result = built.result;
          fileName = built.fileName;
          successfulEndpoint = valuesAttempt.endpoint;
          successfulContentType = valuesAttempt.contentType;
          successfulStatus = valuesAttempt.status;
          workbookText = valuesAttempt.csvText;
          console.log(
            `[googleSheetImport] values.get fallback success rows=${valuesAttempt.matrix.length} durationMs=${
              Date.now() - valuesFallbackStartedAt
            }`,
          );
          console.log(
            `[googleSheetImportPerf] source=${
              valuesAttempt.sourceTransport ?? "values.get"
            }`,
          );
          console.log(
            `[googleSheetImportPerf] totalImportMs=${Date.now() - totalStartedAt}`,
          );
          logGoogleSheetImportPerf("totalFastImport", fastImportStartedAt);
          logGoogleSheetImportPerf("total", totalStartedAt);
          valuesFailure = null;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          valuesFailure = {
            success: false,
            error: `Google Sheets API import failed: ${message}`,
            status: 422,
            responseStatus: valuesAttempt.status,
            statusText: valuesAttempt.statusText,
            technicalDetail: message,
            errorMessage: message,
          };
          console.error("[google-sheet-import] values.get import failed", {
            sheetId,
            gid,
            endpoint: valuesAttempt.endpoint.name,
            url: valuesAttempt.endpoint.url,
            status: valuesAttempt.status,
            contentType: valuesAttempt.contentType,
            error: message,
          });
          console.log(
            `[googleSheetImport] values.get fallback failed error=${message}`,
          );
        }
      } else {
        valuesFailure = valuesAttempt;
        console.log(
          `[googleSheetImport] values.get fallback failed error=${valuesAttempt.error}`,
        );
      }
    }

    if (!result || !successfulEndpoint) {
      const fallbackFailure: CsvDownloadFailure = {
        success: false as const,
        endpoint: endpoints[endpoints.length - 1],
        error: googleSheetImportError,
        status: 502,
        technicalDetail: buildTechnicalDetail({
          endpoint: endpoints[endpoints.length - 1],
          errorMessage: googleSheetImportError,
        }),
      };
      const csvFailure: CsvDownloadFailure = finalFailure ?? fallbackFailure;
      const preferredFailure = valuesFailure ?? csvFailure;
      const preferredFailureEndpoint =
        "endpoint" in preferredFailure
          ? (preferredFailure as CsvDownloadFailure).endpoint
          : null;
      if (finalFailure) {
        console.log(
          `[googleSheetImport] csv primary failed error=${finalFailure.error}`,
        );
      }
      logGoogleSheetImportPerf("total", totalStartedAt);
      console.log(
        `[googleSheetImport] import failed durationMs=${
          Date.now() - totalStartedAt
        }`,
      );

      return googleSheetImportFailure(
        preferredFailure.error,
        preferredFailure.status,
        {
          sheetId,
          gid,
          endpoint: preferredFailureEndpoint?.name ?? "values.get",
          url: preferredFailureEndpoint?.url ?? null,
          status: preferredFailure.responseStatus,
          statusText: preferredFailure.statusText,
          contentType:
            "contentType" in preferredFailure
              ? preferredFailure.contentType
              : undefined,
          textLength:
            "textLength" in preferredFailure
              ? preferredFailure.textLength
              : undefined,
          errorMessage: preferredFailure.errorMessage,
          valuesGetFailure: valuesFailure
            ? `${valuesFailure.error} (${valuesFailure.technicalDetail})`
            : null,
          attempts: attempts.map(summarizeAttempt),
        },
        preferredFailure.technicalDetail,
      );
    }

    const finalImportTotalMs = Date.now() - totalStartedAt;
    result = attachGoogleSheetImportTotalMs(result, finalImportTotalMs);
    console.log(
      `[googleSheetImport] import success durationMs=${finalImportTotalMs}`,
    );
    console.log(`[googleSheetImport] totalMs=${finalImportTotalMs}`);
    return NextResponse.json({
      success: true,
      result,
      fileName,
      gid,
      spreadsheetId: sheetId,
      sync: result.debug.sourceGoogleSheet,
      endpoint: successfulEndpoint.name,
      contentType: successfulContentType,
      status: successfulStatus,
      sourceUrl: rawUrl.trim(),
      workbookBase64: Buffer.from(workbookText, "utf8").toString("base64"),
    });
  } catch (e) {
    const diagnostics = getErrorDiagnostics(e);
    const message = diagnostics.message;
    logGoogleSheetImportPerf("total", totalStartedAt);
    console.log(
      `[googleSheetImport] import failed durationMs=${
        Date.now() - totalStartedAt
      }`,
    );
    console.error("[google-sheet-import] unexpected failure", {
      rawUrl,
      sheetId,
      gid,
      ...diagnostics,
    });
    return googleSheetImportFailure(
      googleSheetImportError,
      500,
      { rawUrl, sheetId, gid, error: message },
      message,
    );
  }
}
