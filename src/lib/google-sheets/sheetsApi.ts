import { request as httpsRequest } from "node:https";
import {
  GoogleOAuthNetworkError,
  getGoogleAuthStatus,
  getGoogleSheetsAccessToken,
  refreshGoogleSheetsAccessToken,
} from "./oauth";
import { normalizeValue } from "../analytics/matcher/normalize";

const googleSheetsApiBaseUrl = "https://sheets.googleapis.com/v4";
const googleSheetsBatchUpdateSize = 1;
const googleSheetsNonWritebackRequestTimeoutMs = 25000;
const googleSheetsHttpsFallbackRequestTimeoutMs = 30000;
const googleSheetsWritebackRequestTimeoutMs =
  googleSheetsHttpsFallbackRequestTimeoutMs;
const googleSheetsNetworkRetryDelaysMs = [1000, 2000, 5000];
const googleSheetsMaxNetworkAttempts = 3;
const googleSheetHierarchyColumnCount = 5;
const googleSheetLeafColumnStartIndex = 2;
const googleSheetLeafColumnEndIndex = 4;
const googleSheetCheckboxColumnIndex = 6;
const googleSheetRowIndexCacheVersion = "v4";
const retryableNetworkCodes = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ABORT_ERR",
]);

const sheetTitleCache = new Map<string, string>();
const googleSheetRowIndexCache = new Map<string, GoogleSheetRowIndexResult>();
const googleRowIndexDiagnosticEvents = [
  "subscription.second.time.subscription.impression",
  "subscription.second.time.subscription.impression.click",
  "subscription.second.time.subscription.impression.close",
  "subscription.second.time.subscription.impression.confirmed",
  "subscription.second.time",
  "funnel.onboarding",
  "funnel.main.menu.play.click",
  "funnel.main.menu.settings.click",
  "funnel.splashscreen",
  "funnel.onboarding.step1",
  "funnel.onboarding.step2",
  "funnel.onboarding.subscription",
  "funnel.main.menu.gift.click",
];

export type GoogleSheetTitleDebugSheet = {
  sheetId: string;
  title: string;
};

export type GoogleSheetCheckboxCandidate = {
  columnIndex: number;
  count: number;
  dataValidationCount: number;
  boolValueCount: number;
  header: string;
};

export type GoogleSheetPassedUpdate = {
  rowId: string;
  rowNumber: number;
  eventName?: string | null;
  checkboxColumnIndex?: number | null;
  statusColumnIndex?: number | null;
  doneColumnIndex: number | null;
  checkColumnIndex: number | null;
};

export type GoogleSheetSyncRequest = {
  spreadsheetId: string;
  gid: string;
  sheetTitle?: string | null;
  manualSheetTitle?: string | null;
  debugLabel?: string | null;
  updates: GoogleSheetPassedUpdate[];
};

type GoogleSheetSyncResult = {
  updatedRanges: number;
  updatedRowIds: string[];
  pendingUpdateCount: number;
  endpoint: string;
  requestBody: unknown;
  writeMode: string;
  ranges: string[];
  apiStatus: number | null;
  apiResponse: string;
  totalUpdatedCells: number | null;
  totalUpdatedRows: number | null;
  updatedData: unknown;
  warning: string | null;
};

export type GoogleSheetNetworkAttemptDebug = {
  attempt: number;
  maxAttempts: number;
  transport: "fetch" | "https primary" | "https fallback";
  errorName: string | null;
  errorMessage: string | null;
  causeCode: string | null;
  causeMessage: string | null;
  technicalDetail: string;
};

type GoogleSheetErrorDebug = {
  errorName?: string | null;
  errorMessage?: string | null;
  causeCode?: string | null;
  causeMessage?: string | null;
  attemptCount?: number | null;
  attempts?: GoogleSheetNetworkAttemptDebug[];
};

export class GoogleSheetSyncError extends Error {
  status: number;
  technicalDetail?: string;
  isNetworkError: boolean;
  availableSheets?: GoogleSheetTitleDebugSheet[];
  errorName?: string;
  errorMessage?: string;
  causeCode?: string;
  causeMessage?: string;
  attemptCount?: number;
  attempts?: GoogleSheetNetworkAttemptDebug[];

  constructor(
    message: string,
    status: number,
    technicalDetail?: string,
    isNetworkError = false,
    availableSheets?: GoogleSheetTitleDebugSheet[],
    debug?: GoogleSheetErrorDebug,
  ) {
    super(message);
    this.name = "GoogleSheetSyncError";
    this.status = status;
    this.technicalDetail = technicalDetail;
    this.isNetworkError = isNetworkError;
    this.availableSheets = availableSheets;
    this.errorName = debug?.errorName ?? undefined;
    this.errorMessage = debug?.errorMessage ?? undefined;
    this.causeCode = debug?.causeCode ?? undefined;
    this.causeMessage = debug?.causeMessage ?? undefined;
    this.attemptCount = debug?.attemptCount ?? undefined;
    this.attempts = debug?.attempts;
  }
}

function asColumnIndex(value: number | null): number | null {
  return value !== null && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function parseGoogleSheetId(gid: string): number | null {
  const sheetId = Number(gid.trim());
  return Number.isInteger(sheetId) && sheetId >= 0 ? sheetId : null;
}

function columnIndexToA1(index: number | null): string {
  if (index === null) {
    return "null";
  }
  let n = index + 1;
  let label = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

function isGoogleSheetsBooleanCell(value: GoogleSheetGridValue): {
  hasBooleanValidation: boolean;
  hasBoolValue: boolean;
} {
  const conditionType = value.dataValidation?.condition?.type;
  return {
    hasBooleanValidation: conditionType === "BOOLEAN",
    hasBoolValue:
      typeof value.effectiveValue?.boolValue === "boolean" ||
      typeof value.userEnteredValue?.boolValue === "boolean",
  };
}

function normalizeGoogleSheetCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  if (text === "") return "";
  return text.replace(/\s+/g, " ");
}

function googleSheetExtendedValueToString(
  value:
    | {
        boolValue?: boolean;
        stringValue?: string;
        numberValue?: number;
        formulaValue?: string;
      }
    | undefined,
): string {
  if (!value) {
    return "";
  }
  if (typeof value.boolValue === "boolean") {
    return value.boolValue ? "TRUE" : "FALSE";
  }
  if (typeof value.stringValue === "string") {
    return normalizeGoogleSheetCell(value.stringValue);
  }
  if (typeof value.numberValue === "number") {
    return normalizeGoogleSheetCell(value.numberValue);
  }
  if (typeof value.formulaValue === "string") {
    return normalizeGoogleSheetCell(value.formulaValue);
  }
  return "";
}

function googleSheetGridValueToString(value: GoogleSheetGridValue): string {
  if (typeof value.effectiveValue?.boolValue === "boolean") {
    return value.effectiveValue.boolValue ? "TRUE" : "FALSE";
  }
  if (typeof value.userEnteredValue?.boolValue === "boolean") {
    return value.userEnteredValue.boolValue ? "TRUE" : "FALSE";
  }
  const formatted = normalizeGoogleSheetCell(value.formattedValue);
  if (formatted) {
    return formatted;
  }
  return (
    googleSheetExtendedValueToString(value.effectiveValue) ||
    googleSheetExtendedValueToString(value.userEnteredValue)
  );
}

function ensureMatrixCell<T>(
  matrix: T[][],
  rowIndex: number,
  columnIndex: number,
  fill: T,
): void {
  while (matrix.length <= rowIndex) {
    matrix.push([]);
  }
  const row = matrix[rowIndex];
  while (row.length <= columnIndex) {
    row.push(fill);
  }
}

function rectangularizeStrings(rows: string[][], width: number): string[][] {
  return rows.map((row) => {
    const next = row.slice();
    while (next.length < width) next.push("");
    return next;
  });
}

function rectangularizeBooleans(rows: boolean[][], width: number): boolean[][] {
  return rows.map((row) => {
    const next = row.slice();
    while (next.length < width) next.push(false);
    return next;
  });
}

function chooseCheckboxCandidate(
  candidates: GoogleSheetCheckboxCandidate[],
  preferredColumnIndex?: number | null,
): {
  checkboxColumnIndex: number | null;
  checkboxColumnDetectionError: string | null;
} {
  if (candidates.length === 0) {
    return {
      checkboxColumnIndex: null,
      checkboxColumnDetectionError: "Checkbox column not found",
    };
  }

  const validationCandidates = candidates.filter(
    (candidate) => candidate.dataValidationCount > 0,
  );
  const eligibleCandidates =
    validationCandidates.length > 0 ? validationCandidates : candidates;
  const preferred = eligibleCandidates.find(
    (candidate) => candidate.columnIndex === preferredColumnIndex,
  );
  if (preferred) {
    return {
      checkboxColumnIndex: preferred.columnIndex,
      checkboxColumnDetectionError: null,
    };
  }

  const sorted = [...eligibleCandidates].sort(
    (a, b) =>
      b.dataValidationCount - a.dataValidationCount ||
      b.count - a.count ||
      a.columnIndex - b.columnIndex,
  );
  const best = sorted[0];
  const second = sorted[1];
  if (
    best &&
    (!second ||
      best.dataValidationCount > second.dataValidationCount ||
      best.count > second.count)
  ) {
    return {
      checkboxColumnIndex: best.columnIndex,
      checkboxColumnDetectionError: null,
    };
  }

  return {
    checkboxColumnIndex: null,
    checkboxColumnDetectionError: "Multiple checkbox columns found",
  };
}

type GoogleApiRequestOptions = {
  method?: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  spreadsheetId: string;
  updateCount: number;
  accessTokenExists: boolean;
  accessTokenLength: number;
  refreshTokenExists: boolean;
  timeoutMs?: number;
  fallbackTimeoutMs?: number;
  fallbackToHttpsOnFetchError?: boolean;
  logPrefix?: "googleSheetSync" | "googleSheetColumns";
  onResponse?: (response: GoogleApiTextResponse) => void;
};

type GoogleApiTextResponse = {
  status: number;
  statusText: string;
  text: string;
};

type GoogleSheetGridValue = {
  formattedValue?: string;
  dataValidation?: { condition?: { type?: string } };
  effectiveValue?: {
    boolValue?: boolean;
    stringValue?: string;
    numberValue?: number;
    formulaValue?: string;
  };
  userEnteredValue?: {
    boolValue?: boolean;
    stringValue?: string;
    numberValue?: number;
    formulaValue?: string;
  };
};

type GoogleSheetGridData = {
  startRow?: number;
  startColumn?: number;
  rowData?: Array<{ values?: GoogleSheetGridValue[] }>;
};

type GoogleSheetGridMetadata = {
  sheets?: Array<{
    properties?: { sheetId?: number | string; title?: string };
    data?: GoogleSheetGridData[];
  }>;
};

export type GoogleSheetGridMatrix = {
  matrix: string[][];
  checkboxMatrix: boolean[][];
  sheetTitle: string | null;
  matrixRowCount: number;
  matrixColCount: number;
};

export type GoogleSheetRowIndexEntry = {
  eventName: string;
  normalizedEventName: string;
  rowNumbers: number[];
  rawRows: string[][];
  rowDetails?: GoogleSheetRowIndexRowDebug[];
};

export type GoogleSheetRowIndexRowDebug = {
  rowNumber: number;
  eventName: string;
  normalizedEventName: string;
  range: string | null;
  leaf: boolean;
  parent: boolean;
  gValue: string;
  actualColumns: string[];
  indexed: boolean;
  reason: string | null;
};

export type GoogleSheetRowIndexResult = {
  spreadsheetId: string;
  sheetTitle: string;
  range: string;
  cacheVersion: string;
  rowCount: number;
  indexedEventCount: number;
  entries: GoogleSheetRowIndexEntry[];
  debugRows: GoogleSheetRowIndexRowDebug[];
};

function parseGoogleApiErrorText(text: string): string {
  try {
    const payload = JSON.parse(text) as {
      error?: { message?: string; status?: string };
    };
    return payload.error?.message || payload.error?.status || text;
  } catch {
    return text;
  }
}

function messageForStatus(status: number): string {
  return `Google API ${status}`;
}

function getObjectProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || !(key in value)) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
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

function getErrorCause(error: unknown): unknown {
  return getObjectProperty(error, "cause");
}

function stringifyDetail(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number") {
    return String(value);
  }
  return null;
}

function fetchFailedTechnicalDetail(error: unknown): string {
  const cause = getErrorCause(error);
  const detail =
    stringifyDetail(getObjectProperty(cause, "code")) ??
    stringifyDetail(getObjectProperty(cause, "message")) ??
    stringifyDetail(getErrorMessage(error)) ??
    String(error);

  return `fetch failed: ${detail}`;
}

function networkTechnicalDetail(error: unknown): string {
  const cause = getErrorCause(error);
  const code = stringifyDetail(getObjectProperty(cause, "code"));
  const causeMessage = stringifyDetail(getObjectProperty(cause, "message"));
  if (code && causeMessage && causeMessage !== code) {
    return `${code}: ${causeMessage}`;
  }
  return (
    code ??
    causeMessage ??
    stringifyDetail(getErrorMessage(error)) ??
    String(error)
  );
}

function isConnectionResetError(error: unknown): boolean {
  return /ECONNRESET|connection reset/i.test(networkTechnicalDetail(error));
}

function getGoogleErrorDebug(error: unknown): GoogleSheetErrorDebug {
  const cause = getErrorCause(error);
  return {
    errorName: stringifyDetail(getErrorName(error)),
    errorMessage: stringifyDetail(getErrorMessage(error)),
    causeCode: stringifyDetail(getObjectProperty(cause, "code")),
    causeMessage: stringifyDetail(getErrorMessage(cause)),
  };
}

function buildNetworkAttemptDebug(
  attempt: number,
  transport: GoogleSheetNetworkAttemptDebug["transport"],
  error: unknown,
): GoogleSheetNetworkAttemptDebug {
  const debug = getGoogleErrorDebug(error);
  return {
    attempt,
    maxAttempts: googleSheetsMaxNetworkAttempts,
    transport,
    errorName: debug.errorName ?? null,
    errorMessage: debug.errorMessage ?? null,
    causeCode: debug.causeCode ?? null,
    causeMessage: debug.causeMessage ?? null,
    technicalDetail: networkTechnicalDetail(error),
  };
}

function getAttemptCount(attempts: GoogleSheetNetworkAttemptDebug[]): number {
  return attempts.reduce(
    (max, attempt) => Math.max(max, attempt.attempt),
    0,
  );
}

function createGoogleSheetsNetworkError(
  error: unknown,
  attempts: GoogleSheetNetworkAttemptDebug[],
): GoogleSheetSyncError {
  const debug = getGoogleErrorDebug(error);
  return new GoogleSheetSyncError(
    "Sheet sync: network issue, will retry",
    503,
    networkTechnicalDetail(error),
    true,
    undefined,
    {
      ...debug,
      attemptCount: getAttemptCount(attempts),
      attempts,
    },
  );
}

function createGoogleSheetsWritebackNetworkError(
  error: unknown,
  attempts: GoogleSheetNetworkAttemptDebug[],
): GoogleSheetSyncError {
  const debug = getGoogleErrorDebug(error);
  const message = isConnectionResetError(error)
    ? "Google API connection reset during writeback"
    : "Sheet sync: network issue, will retry";
  return new GoogleSheetSyncError(
    message,
    503,
    networkTechnicalDetail(error),
    true,
    undefined,
    {
      ...debug,
      attemptCount: getAttemptCount(attempts),
      attempts,
    },
  );
}

function isRetryableNetworkError(error: unknown): boolean {
  const cause = getErrorCause(error);
  const causeCode = stringifyDetail(getObjectProperty(cause, "code"));
  const name = stringifyDetail(getErrorName(error));
  const message = stringifyDetail(getErrorMessage(error));
  const causeMessage = stringifyDetail(getErrorMessage(cause));

  return (
    (causeCode !== null && retryableNetworkCodes.has(causeCode)) ||
    name === "AbortError" ||
    name === "TimeoutError" ||
    message === "fetch failed" ||
    /timed out|timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(
      `${message ?? ""} ${causeMessage ?? ""}`,
    )
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sheetTitleCacheKey(spreadsheetId: string, gid: string): string {
  return `${spreadsheetId}\0${gid}`;
}

function safeEndpointUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.searchParams.delete("access_token");
    return url.toString();
  } catch {
    return rawUrl.replace(/([?&]access_token=)[^&]+/i, "$1<redacted>");
  }
}

function isGoogleSheetWritebackRequest(url: string): boolean {
  return url.includes("values:batchUpdate");
}

function logGoogleApiFetchFailure(
  url: string,
  options: GoogleApiRequestOptions,
  error: unknown,
): void {
  const cause = getErrorCause(error);
  const prefix = options.logPrefix ?? "googleSheetSync";
  console.error(`[${prefix}] fetch failed`, {
    name: getErrorName(error),
    message: getErrorMessage(error),
    causeCode: getObjectProperty(cause, "code"),
    causeMessage: getErrorMessage(cause),
    causeHostname: getObjectProperty(cause, "hostname"),
  });
}

function getRequestHeader(
  headers: Record<string, string>,
  name: string,
): string {
  const match = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return match?.[1] ?? "";
}

function logGoogleSheetSyncRequest(
  url: string,
  options: GoogleApiRequestOptions,
): void {
  console.log(`[googleSheetSync] endpoint=${safeEndpointUrl(url)}`);
  console.log(`[googleSheetSync] spreadsheetId=${options.spreadsheetId}`);
  console.log(`[googleSheetSync] updates=${options.updateCount}`);
  console.log(
    `[googleSheetSync] accessTokenExists=${options.accessTokenExists}`,
  );
  console.log(
    `[googleSheetSync] accessTokenLength=${options.accessTokenLength}`,
  );
  console.log(
    `[googleSheetSync] refreshTokenExists=${options.refreshTokenExists}`,
  );
  if (isGoogleSheetWritebackRequest(url)) {
    console.log(
      `[googleSheetSync] request timeoutMs=${
        options.timeoutMs ?? googleSheetsNonWritebackRequestTimeoutMs
      }`,
    );
  }
}

function assertGoogleApiRequestOptions(
  options: GoogleApiRequestOptions,
): void {
  const authorization = getRequestHeader(options.headers, "authorization");
  if (
    !options.accessTokenExists ||
    options.accessTokenLength === 0 ||
    !authorization.startsWith("Bearer ") ||
    authorization.trim() === "Bearer"
  ) {
    throw new GoogleSheetSyncError(
      "Google access token is missing. Reconnect Google.",
      401,
      "Authorization header is missing a bearer access token.",
    );
  }

  if ((options.method ?? "GET") === "POST") {
    const contentType = getRequestHeader(options.headers, "content-type");
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new GoogleSheetSyncError(
        "Google Sheets request is missing Content-Type header.",
        500,
        "Content-Type: application/json is required for Google Sheets API POST requests.",
      );
    }
  }
}

function parseGoogleApiJson<T>(text: string): T {
  if (!text.trim()) {
    return {} as T;
  }
  return JSON.parse(text) as T;
}

function httpsRequestJson(
  url: string,
  options: GoogleApiRequestOptions,
  transportRole: "primary" | "fallback" = "fallback",
): Promise<GoogleApiTextResponse> {
  return new Promise((resolve, reject) => {
    const body = options.body;
    const timeoutMs =
      options.fallbackTimeoutMs ?? googleSheetsHttpsFallbackRequestTimeoutMs;
    const isWritebackRequest = isGoogleSheetWritebackRequest(url);
    const startedAt = Date.now();
    const headers = { ...options.headers };
    if (body !== undefined && headers["Content-Length"] === undefined) {
      headers["Content-Length"] = String(Buffer.byteLength(body, "utf8"));
    }

    if (isWritebackRequest) {
      if (transportRole === "primary") {
        console.log(`[googleSheetSync] https start timeoutMs=${timeoutMs}`);
      } else {
        console.log(`[googleSheetSync] fallback start timeoutMs=${timeoutMs}`);
      }
    }

    const request = httpsRequest(
      url,
      {
        method: options.method ?? "GET",
        headers,
        timeout: timeoutMs,
      },
      (response) => {
        response.setEncoding("utf8");
        const chunks: string[] = [];
        const status = response.statusCode ?? 0;
        if (isWritebackRequest) {
          if (transportRole === "primary") {
            console.log(`[googleSheetSync] https response.status=${status}`);
          } else {
            console.log(`[googleSheetSync] response.status=${status}`);
          }
        }

        response.on("error", (error) => {
          if (isWritebackRequest) {
            if (transportRole === "primary") {
              console.log(
                `[googleSheetSync] https durationMs=${Date.now() - startedAt}`,
              );
              console.error(
                `[googleSheetSync] https failed error=${networkTechnicalDetail(
                  error,
                )}`,
              );
            } else {
              console.log(`[googleSheetSync] durationMs=${Date.now() - startedAt}`);
            }
          }
          reject(error);
        });
        response.on("data", (chunk: string) => chunks.push(chunk));
        response.on("end", () => {
          if (isWritebackRequest) {
            if (transportRole === "primary") {
              console.log(
                `[googleSheetSync] https durationMs=${Date.now() - startedAt}`,
              );
            } else {
              console.log(`[googleSheetSync] durationMs=${Date.now() - startedAt}`);
            }
          }
          resolve({
            status,
            statusText: response.statusMessage ?? "",
            text: chunks.join(""),
          });
        });
      },
    );

    request.on("timeout", () => {
      if (isWritebackRequest) {
        if (transportRole === "primary") {
          console.error(`[googleSheetSync] https timeout after ${timeoutMs}ms`);
        } else {
          console.error(`[googleSheetSync] fallback timeout after ${timeoutMs}ms`);
        }
      }
      request.destroy(
        new Error(
          `Google Sheets HTTPS request timed out after ${timeoutMs}ms`,
        ),
      );
    });
    request.on("error", (error) => {
      if (isWritebackRequest) {
        if (transportRole === "primary") {
          console.log(
            `[googleSheetSync] https durationMs=${Date.now() - startedAt}`,
          );
          console.error(
            `[googleSheetSync] https failed error=${networkTechnicalDetail(
              error,
            )}`,
          );
        } else {
          console.log(`[googleSheetSync] durationMs=${Date.now() - startedAt}`);
        }
      }
      reject(error);
    });

    if (body !== undefined) {
      request.write(body);
    }
    request.end();
  });
}

async function googleWritebackHttpsPrimaryJson<T>(
  url: string,
  options: GoogleApiRequestOptions,
): Promise<T> {
  const logPrefix = options.logPrefix ?? "googleSheetSync";
  let lastNetworkError: unknown = null;
  const attempts: GoogleSheetNetworkAttemptDebug[] = [];

  console.log("[googleSheetSync] writeback transport=https primary");
  for (let attempt = 1; attempt <= googleSheetsMaxNetworkAttempts; attempt++) {
    console.log(
      `[${logPrefix}] attempt=${attempt}/${googleSheetsMaxNetworkAttempts}`,
    );
    try {
      const response = await httpsRequestJson(url, options, "primary");
      options.onResponse?.(response);
      console.log(`[googleSheetSync] response body=${response.text}`);
      if (response.status < 200 || response.status >= 300) {
        const apiMessage = parseGoogleApiErrorText(response.text);
        throw new GoogleSheetSyncError(
          `${messageForStatus(response.status)}: ${apiMessage}`,
          response.status,
          apiMessage,
        );
      }
      return parseGoogleApiJson<T>(response.text);
    } catch (error) {
      if (error instanceof GoogleSheetSyncError) {
        throw error;
      }
      lastNetworkError = error;
      const httpsAttempt = buildNetworkAttemptDebug(
        attempt,
        "https primary",
        error,
      );
      attempts.push(httpsAttempt);
      console.error(
        `[${logPrefix}] attempt=${attempt}/${googleSheetsMaxNetworkAttempts} transport=https primary failed`,
        httpsAttempt,
      );

      if (
        !isRetryableNetworkError(error) ||
        attempt >= googleSheetsMaxNetworkAttempts
      ) {
        throw createGoogleSheetsWritebackNetworkError(
          lastNetworkError,
          attempts,
        );
      }

      await sleep(googleSheetsNetworkRetryDelaysMs[attempt - 1] ?? 5000);
    }
  }

  throw createGoogleSheetsWritebackNetworkError(lastNetworkError, attempts);
}

async function googleFetchJson<T>(
  url: string,
  options: GoogleApiRequestOptions,
): Promise<T> {
  logGoogleSheetSyncRequest(url, options);
  assertGoogleApiRequestOptions(options);
  const logPrefix = options.logPrefix ?? "googleSheetSync";
  const requestTimeoutMs =
    options.timeoutMs ?? googleSheetsNonWritebackRequestTimeoutMs;
  const isWritebackRequest = isGoogleSheetWritebackRequest(url);

  if (isWritebackRequest) {
    return googleWritebackHttpsPrimaryJson<T>(url, options);
  }

  let lastNetworkError: unknown = null;
  const attempts: GoogleSheetNetworkAttemptDebug[] = [];
  for (let attempt = 1; attempt <= googleSheetsMaxNetworkAttempts; attempt++) {
    console.log(
      `[${logPrefix}] attempt=${attempt}/${googleSheetsMaxNetworkAttempts}`,
    );
    const controller = new AbortController();
    const fetchStartedAt = Date.now();
    const timeout = setTimeout(() => {
      if (isWritebackRequest) {
        console.error(
          `[googleSheetSync] fetch timeout after ${requestTimeoutMs}ms`,
        );
      }
      controller.abort();
    }, requestTimeoutMs);
    try {
      if (isWritebackRequest) {
        console.log("[googleSheetSync] fetch start");
      }
      const response = await fetch(url, {
        method: options.method ?? "GET",
        headers: options.headers,
        body: options.body,
        signal: controller.signal,
      });
      const responseText = await response.text();
      if (isWritebackRequest) {
        console.log(`[googleSheetSync] response.status=${response.status}`);
        console.log(`[googleSheetSync] durationMs=${Date.now() - fetchStartedAt}`);
      }
      options.onResponse?.({
        status: response.status,
        statusText: response.statusText,
        text: responseText,
      });
      if (isWritebackRequest) {
        console.log(`[googleSheetSync] response body=${responseText}`);
      }
      if (!response.ok) {
        if (url.includes("fields=sheets(properties(sheetId,title))")) {
          console.error(`[googleSheetTitle] status=${response.status}`);
          console.error(`[googleSheetTitle] body=${responseText}`);
        }
        const apiMessage = parseGoogleApiErrorText(responseText);
        throw new GoogleSheetSyncError(
          `${messageForStatus(response.status)}: ${apiMessage}`,
          response.status,
          apiMessage,
        );
      }
      return parseGoogleApiJson<T>(responseText);
    } catch (error) {
      if (error instanceof GoogleSheetSyncError) {
        throw error;
      }
      if (isWritebackRequest) {
        console.log(`[googleSheetSync] durationMs=${Date.now() - fetchStartedAt}`);
      }

      logGoogleApiFetchFailure(url, options, error);
      lastNetworkError = error;
      const fetchAttempt = buildNetworkAttemptDebug(attempt, "fetch", error);
      attempts.push(fetchAttempt);
      console.error(
        `[${logPrefix}] attempt=${attempt}/${googleSheetsMaxNetworkAttempts} transport=fetch failed`,
        fetchAttempt,
      );

      if (options.fallbackToHttpsOnFetchError) {
        try {
          console.warn(`[${logPrefix}] falling back to node:https`, {
            endpointUrl: safeEndpointUrl(url),
            method: options.method ?? "GET",
            accessTokenExists: options.accessTokenExists,
            attempt,
          });
          const fallbackResponse = await httpsRequestJson(url, options);
          options.onResponse?.(fallbackResponse);
          if (isWritebackRequest) {
            console.log(`[googleSheetSync] response body=${fallbackResponse.text}`);
          }
          if (fallbackResponse.status < 200 || fallbackResponse.status >= 300) {
            if (url.includes("fields=sheets(properties(sheetId,title))")) {
              console.error(
                `[googleSheetTitle] status=${fallbackResponse.status}`,
              );
              console.error(`[googleSheetTitle] body=${fallbackResponse.text}`);
            }
            const apiMessage = parseGoogleApiErrorText(fallbackResponse.text);
            throw new GoogleSheetSyncError(
              `${messageForStatus(fallbackResponse.status)}: ${apiMessage}`,
              fallbackResponse.status,
              apiMessage,
            );
          }
          return parseGoogleApiJson<T>(fallbackResponse.text);
        } catch (fallbackError) {
          if (fallbackError instanceof GoogleSheetSyncError) {
            throw fallbackError;
          }
          lastNetworkError = fallbackError;
          const fallbackAttempt = buildNetworkAttemptDebug(
            attempt,
            "https fallback",
            fallbackError,
          );
          attempts.push(fallbackAttempt);
          console.error(
            `[${logPrefix}] attempt=${attempt}/${googleSheetsMaxNetworkAttempts} transport=https fallback failed`,
            fallbackAttempt,
          );
        }
      }

      const retryable =
        isRetryableNetworkError(error) ||
        (lastNetworkError !== null && isRetryableNetworkError(lastNetworkError));
      if (!retryable || attempt >= googleSheetsMaxNetworkAttempts) {
        throw createGoogleSheetsNetworkError(lastNetworkError ?? error, attempts);
      }

      await sleep(googleSheetsNetworkRetryDelaysMs[attempt - 1] ?? 5000);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw createGoogleSheetsNetworkError(lastNetworkError, attempts);
}

function getSpreadsheetMetadataUrl(spreadsheetId: string): string {
  return `${googleSheetsApiBaseUrl}/spreadsheets/${encodeURIComponent(
    spreadsheetId,
  )}?fields=sheets(properties(sheetId,title))`;
}

function getSpreadsheetGridMetadataUrl(spreadsheetId: string): string {
  const fields =
    "sheets(properties(sheetId,title),data(startRow,startColumn,rowData(values(formattedValue,dataValidation,effectiveValue,userEnteredValue))))";
  const url = new URL(
    `${googleSheetsApiBaseUrl}/spreadsheets/${encodeURIComponent(
      spreadsheetId,
    )}`,
  );
  url.searchParams.set("includeGridData", "true");
  url.searchParams.set("fields", fields);
  return url.toString();
}

function getBatchUpdateUrl(spreadsheetId: string): string {
  return `${googleSheetsApiBaseUrl}/spreadsheets/${encodeURIComponent(
    spreadsheetId,
  )}/values:batchUpdate`;
}

function getValuesUrl(spreadsheetId: string, range: string): string {
  const url = new URL(
    `${googleSheetsApiBaseUrl}/spreadsheets/${encodeURIComponent(
      spreadsheetId,
    )}/values/${encodeURIComponent(range)}`,
  );
  url.searchParams.set("majorDimension", "ROWS");
  url.searchParams.set("valueRenderOption", "FORMATTED_VALUE");
  return url.toString();
}

function getGoogleSheetWriteTitle(request: GoogleSheetSyncRequest): string | null {
  const manualTitle = request.manualSheetTitle?.trim();
  if (manualTitle) {
    return manualTitle;
  }
  const resolvedTitle = request.sheetTitle?.trim();
  return resolvedTitle || null;
}

function normalizeSheetTitleForA1(sheetTitle: string): string {
  const trimmed = sheetTitle.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function quoteSheetTitle(sheetTitle: string): string {
  const normalizedTitle = normalizeSheetTitleForA1(sheetTitle);
  return `'${normalizedTitle.replace(/'/g, "''")}'`;
}

function buildA1Range(
  sheetTitle: string,
  columnIndex: number,
  rowNumber: number,
): string {
  return `${quoteSheetTitle(sheetTitle)}!${columnIndexToA1(columnIndex)}${rowNumber}`;
}

function buildA1ColumnRange(sheetTitle: string, startColumn: string, endColumn: string): string {
  return `${quoteSheetTitle(sheetTitle)}!${startColumn}:${endColumn}`;
}

function parseBatchUpdateDebug(responseText: string): {
  totalUpdatedCells: number | null;
  totalUpdatedRows: number | null;
  updatedData: unknown;
} {
  try {
    const payload = JSON.parse(responseText) as {
      totalUpdatedCells?: unknown;
      totalUpdatedRows?: unknown;
      responses?: Array<{ updatedData?: unknown }>;
    };
    return {
      totalUpdatedCells:
        typeof payload.totalUpdatedCells === "number"
          ? payload.totalUpdatedCells
          : null,
      totalUpdatedRows:
        typeof payload.totalUpdatedRows === "number"
          ? payload.totalUpdatedRows
          : null,
      updatedData:
        payload.responses
          ?.map((response) => response.updatedData)
          .filter((value) => value !== undefined) ?? null,
    };
  } catch {
    return {
      totalUpdatedCells: null,
      totalUpdatedRows: null,
      updatedData: null,
    };
  }
}

function logGoogleSheetTestWriteFailure(error: unknown): void {
  const debug =
    error instanceof GoogleSheetSyncError
      ? {
          errorName: error.errorName ?? error.name,
          errorMessage: error.errorMessage ?? error.message,
          causeCode: error.causeCode ?? null,
          causeMessage: error.causeMessage ?? null,
          technicalDetail: error.technicalDetail ?? error.message,
          attemptCount: error.attemptCount ?? null,
          attempts: error.attempts ?? [],
        }
      : {
          ...getGoogleErrorDebug(error),
          technicalDetail: networkTechnicalDetail(error),
          attemptCount: null,
          attempts: [],
        };

  console.error("[googleSheetTestWrite] failed");
  console.error(`[googleSheetTestWrite] errorName=${debug.errorName ?? "null"}`);
  console.error(
    `[googleSheetTestWrite] errorMessage=${debug.errorMessage ?? "null"}`,
  );
  console.error(`[googleSheetTestWrite] causeCode=${debug.causeCode ?? "null"}`);
  console.error(
    `[googleSheetTestWrite] causeMessage=${debug.causeMessage ?? "null"}`,
  );
  console.error(
    `[googleSheetTestWrite] technicalDetail=${
      debug.technicalDetail ?? "null"
    }`,
  );
  console.error(
    `[googleSheetTestWrite] attemptCount=${debug.attemptCount ?? "null"}`,
  );
  for (const attempt of debug.attempts) {
    console.error(
      `[googleSheetTestWrite] attempt=${attempt.attempt}/${attempt.maxAttempts} transport=${attempt.transport} errorName=${attempt.errorName ?? "null"} errorMessage=${attempt.errorMessage ?? "null"} causeCode=${attempt.causeCode ?? "null"} causeMessage=${attempt.causeMessage ?? "null"} technicalDetail=${attempt.technicalDetail}`,
    );
  }
}

export async function resolveGoogleSheetTitle(
  spreadsheetId: string,
  gid: string,
  accessToken: string,
  updateCount = 0,
): Promise<string> {
  return (
    await resolveGoogleSheetTitleWithDebug(
      spreadsheetId,
      gid,
      accessToken,
      updateCount,
    )
  ).sheetTitle;
}

export async function resolveGoogleSheetTitleWithDebug(
  spreadsheetId: string,
  gid: string,
  accessToken: string,
  updateCount = 0,
  useCache = true,
): Promise<{
  sheetTitle: string;
  availableSheets: GoogleSheetTitleDebugSheet[];
}> {
  const cacheKey = sheetTitleCacheKey(spreadsheetId, gid);
  const cachedTitle = sheetTitleCache.get(cacheKey);
  if (useCache && cachedTitle) {
    return {
      sheetTitle: cachedTitle,
      availableSheets: [],
    };
  }

  console.log(`[googleSheetSync] spreadsheetId=${spreadsheetId}`);
  console.log(`[googleSheetSync] gid=${gid}`);
  const tokenStatus = getGoogleAuthStatus();
  const metadata = await googleFetchJson<{
    sheets?: Array<{
      properties?: { sheetId?: number | string; title?: string };
    }>;
  }>(
    getSpreadsheetMetadataUrl(spreadsheetId),
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      spreadsheetId,
      updateCount,
      accessTokenExists: Boolean(accessToken),
      accessTokenLength: accessToken.length,
      refreshTokenExists: tokenStatus.refreshTokenExists,
      fallbackToHttpsOnFetchError: true,
    },
  );
  const availableSheets =
    metadata.sheets?.flatMap((item) => {
      const sheetId = item.properties?.sheetId;
      const title = item.properties?.title;
      if (sheetId === undefined || typeof title !== "string") {
        return [];
      }
      return [{ sheetId: String(sheetId), title }];
    }) ?? [];
  console.log(
    `[googleSheetTitle] availableSheets=${JSON.stringify(availableSheets)}`,
  );
  const sheet = metadata.sheets?.find(
    (item) => String(item.properties?.sheetId) === String(gid),
  );
  const title = sheet?.properties?.title;
  if (!title) {
    const availableGids =
      availableSheets.map((item) => item.sheetId).join(", ") || "none";
    throw new GoogleSheetSyncError(
      `Could not find tab with gid=${gid}. Available gids: ${availableGids}`,
      404,
      `Could not find tab with gid=${gid}. Available gids: ${availableGids}`,
      false,
      availableSheets,
    );
  }
  sheetTitleCache.set(cacheKey, title);
  console.log(`[googleSheetSync] resolvedSheetTitle=${title}`);
  return {
    sheetTitle: title,
    availableSheets,
  };
}

export async function resolveGoogleSheetCheckboxColumns(
  spreadsheetId: string,
  gid: string,
  accessToken: string,
  options: {
    headers?: string[];
    preferredColumnIndex?: number | null;
    rowNumbers?: number[];
    updateCount?: number;
  } = {},
): Promise<{
  checkboxColumnIndex: number | null;
  checkboxCandidates: GoogleSheetCheckboxCandidate[];
  checkboxColumnDetectionError: string | null;
}> {
  const sheetId = parseGoogleSheetId(gid);
  if (sheetId === null) {
    return {
      checkboxColumnIndex: null,
      checkboxCandidates: [],
      checkboxColumnDetectionError: `Invalid Google Sheet gid/sheetId: ${gid}`,
    };
  }

  const tokenStatus = getGoogleAuthStatus();
  const metadata = await googleFetchJson<GoogleSheetGridMetadata>(
    getSpreadsheetGridMetadataUrl(spreadsheetId),
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      spreadsheetId,
      updateCount: options.updateCount ?? 0,
      accessTokenExists: Boolean(accessToken),
      accessTokenLength: accessToken.length,
      refreshTokenExists: tokenStatus.refreshTokenExists,
      fallbackToHttpsOnFetchError: true,
      logPrefix: "googleSheetColumns",
    },
  );
  const sheet = metadata.sheets?.find(
    (item) => String(item.properties?.sheetId) === String(sheetId),
  );
  const counts = new Map<
    number,
    { count: number; dataValidationCount: number; boolValueCount: number }
  >();
  const allowedRowIndexes =
    options.rowNumbers && options.rowNumbers.length > 0
      ? new Set(options.rowNumbers.map((rowNumber) => rowNumber - 1))
      : null;

  for (const grid of sheet?.data ?? []) {
    const startRow = grid.startRow ?? 0;
    const startColumn = grid.startColumn ?? 0;
    for (const [rowOffset, row] of (grid.rowData ?? []).entries()) {
      const rowIndex = startRow + rowOffset;
      if (allowedRowIndexes !== null && !allowedRowIndexes.has(rowIndex)) {
        continue;
      }
      row.values?.forEach((value, index) => {
        const { hasBooleanValidation, hasBoolValue } =
          isGoogleSheetsBooleanCell(value);
        if (!hasBooleanValidation && !hasBoolValue) {
          return;
        }
        const columnIndex = startColumn + index;
        const current =
          counts.get(columnIndex) ?? {
            count: 0,
            dataValidationCount: 0,
            boolValueCount: 0,
          };
        current.count++;
        if (hasBooleanValidation) {
          current.dataValidationCount++;
        }
        if (hasBoolValue) {
          current.boolValueCount++;
        }
        counts.set(columnIndex, current);
      });
    }
  }

  const checkboxCandidates = [...counts.entries()]
    .map(([columnIndex, count]) => ({
      columnIndex,
      count: count.count,
      dataValidationCount: count.dataValidationCount,
      boolValueCount: count.boolValueCount,
      header: options.headers?.[columnIndex] ?? "",
    }))
    .sort(
      (a, b) =>
        b.dataValidationCount - a.dataValidationCount ||
        b.count - a.count ||
        a.columnIndex - b.columnIndex,
    );
  const { checkboxColumnIndex, checkboxColumnDetectionError } =
    chooseCheckboxCandidate(
      checkboxCandidates,
      options.preferredColumnIndex ?? null,
    );

  console.log(
    `[googleSheetColumns] candidates=${JSON.stringify(checkboxCandidates)}`,
  );
  console.log(`[googleSheetColumns] selected=${checkboxColumnIndex ?? "null"}`);

  return {
    checkboxColumnIndex,
    checkboxCandidates,
    checkboxColumnDetectionError,
  };
}

export async function fetchGoogleSheetGridMatrix(
  spreadsheetId: string,
  gid: string,
  accessToken: string,
  updateCount = 0,
): Promise<GoogleSheetGridMatrix> {
  const sheetId = parseGoogleSheetId(gid);
  if (sheetId === null) {
    throw new GoogleSheetSyncError(
      `Invalid Google Sheet gid/sheetId: ${gid}`,
      400,
      `Invalid Google Sheet gid/sheetId: ${gid}`,
    );
  }

  const tokenStatus = getGoogleAuthStatus();
  const metadata = await googleFetchJson<GoogleSheetGridMetadata>(
    getSpreadsheetGridMetadataUrl(spreadsheetId),
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      spreadsheetId,
      updateCount,
      accessTokenExists: Boolean(accessToken),
      accessTokenLength: accessToken.length,
      refreshTokenExists: tokenStatus.refreshTokenExists,
      fallbackToHttpsOnFetchError: true,
      logPrefix: "googleSheetColumns",
    },
  );
  const sheet = metadata.sheets?.find(
    (item) => String(item.properties?.sheetId) === String(sheetId),
  );
  if (!sheet) {
    throw new GoogleSheetSyncError(
      `Could not find tab with gid=${gid}`,
      404,
      `Could not find tab with gid=${gid}`,
    );
  }

  const matrix: string[][] = [];
  const checkboxMatrix: boolean[][] = [];
  let maxRowIndex = -1;
  let maxColumnIndex = -1;

  for (const grid of sheet.data ?? []) {
    const startRow = grid.startRow ?? 0;
    const startColumn = grid.startColumn ?? 0;
    for (const [rowOffset, row] of (grid.rowData ?? []).entries()) {
      const rowIndex = startRow + rowOffset;
      maxRowIndex = Math.max(maxRowIndex, rowIndex);
      for (const [valueOffset, value] of (row.values ?? []).entries()) {
        const columnIndex = startColumn + valueOffset;
        maxColumnIndex = Math.max(maxColumnIndex, columnIndex);
        ensureMatrixCell(matrix, rowIndex, columnIndex, "");
        ensureMatrixCell(checkboxMatrix, rowIndex, columnIndex, false);
        matrix[rowIndex][columnIndex] = googleSheetGridValueToString(value);
        const { hasBooleanValidation, hasBoolValue } =
          isGoogleSheetsBooleanCell(value);
        checkboxMatrix[rowIndex][columnIndex] =
          hasBooleanValidation || hasBoolValue;
      }
    }
  }

  const rowCount = maxRowIndex + 1;
  const columnCount = maxColumnIndex + 1;
  while (matrix.length < rowCount) matrix.push([]);
  while (checkboxMatrix.length < rowCount) checkboxMatrix.push([]);
  const rectangularMatrix = rectangularizeStrings(matrix, columnCount);
  const rectangularCheckboxMatrix = rectangularizeBooleans(
    checkboxMatrix,
    columnCount,
  );

  console.log(
    `[googleSheetImport] gridMatrix rowCount=${rowCount} columnCount=${columnCount}`,
  );

  return {
    matrix: rectangularMatrix,
    checkboxMatrix: rectangularCheckboxMatrix,
    sheetTitle: sheet.properties?.title ?? null,
    matrixRowCount: rectangularMatrix.length,
    matrixColCount: columnCount,
  };
}

function normalizeGoogleSheetEventName(value: string): string {
  return normalizeValue(value)
    .replace(/\s*\.\s*/g, ".")
    .replace(/[\s/\\-]+/g, ".")
    .replace(/\.+/g, ".")
    .replace(/^\./, "")
    .replace(/\.$/, "");
}

function valueCellToString(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim().replace(/\s+/g, " ");
}

type GoogleSheetRowScanState = {
  rowNumber: number;
  row: string[];
  levels: string[];
  eventParts: string[];
  eventName: string;
  normalizedEventName: string;
  actualColumnIndexes: number[];
  actualColumns: string[];
  hasActualBCell: boolean;
  hasActualLeafCellInCtoE: boolean;
  gValue: string;
};

function normalizeGoogleSheetHierarchyCell(value: string): string {
  return normalizeGoogleSheetEventName(value) || value.trim();
}

function buildGoogleSheetRowScanStates(
  values: unknown[][],
): GoogleSheetRowScanState[] {
  const levels = Array.from(
    { length: googleSheetHierarchyColumnCount },
    () => "",
  );
  return values.map((rawRow, rowIndex) => {
    const row = Array.isArray(rawRow)
      ? rawRow.map(valueCellToString)
      : [];
    const actualColumnIndexes: number[] = [];

    for (
      let columnIndex = 0;
      columnIndex < googleSheetHierarchyColumnCount;
      columnIndex++
    ) {
      const value = row[columnIndex]?.trim() ?? "";
      if (!value) {
        continue;
      }
      levels[columnIndex] = normalizeGoogleSheetHierarchyCell(value);
      for (let index = columnIndex + 1; index < levels.length; index++) {
        levels[index] = "";
      }
      actualColumnIndexes.push(columnIndex);
    }

    const eventParts = levels.filter(Boolean);
    const eventName = eventParts.join(".");
    const normalizedEventName = normalizeGoogleSheetEventName(eventName);
    const gValue = row[googleSheetCheckboxColumnIndex]?.trim() ?? "";

    return {
      rowNumber: rowIndex + 1,
      row,
      levels: [...levels],
      eventParts,
      eventName,
      normalizedEventName,
      actualColumnIndexes,
      actualColumns: actualColumnIndexes.map(columnIndexToA1),
      hasActualBCell: actualColumnIndexes.includes(1),
      hasActualLeafCellInCtoE: actualColumnIndexes.some(
        (columnIndex) =>
          columnIndex >= googleSheetLeafColumnStartIndex &&
          columnIndex <= googleSheetLeafColumnEndIndex,
      ),
      gValue,
    };
  });
}

function isGoogleSheetParentRow(
  states: GoogleSheetRowScanState[],
  stateIndex: number,
): boolean {
  const state = states[stateIndex];
  if (!state || state.actualColumnIndexes.length === 0) {
    return false;
  }

  const deepestActualColumnIndex = Math.max(...state.actualColumnIndexes);
  if (
    deepestActualColumnIndex >= googleSheetLeafColumnEndIndex ||
    !state.levels[deepestActualColumnIndex]
  ) {
    return false;
  }

  for (let index = stateIndex + 1; index < states.length; index++) {
    const next = states[index];
    const sameContext = state.levels
      .slice(0, deepestActualColumnIndex + 1)
      .every((level, levelIndex) => level && next.levels[levelIndex] === level);
    if (!sameContext) {
      break;
    }
    if (
      next.actualColumnIndexes.some(
        (columnIndex) =>
          columnIndex > deepestActualColumnIndex &&
          columnIndex <= googleSheetLeafColumnEndIndex,
      )
    ) {
      return true;
    }
  }

  return false;
}

function createGoogleSheetRowDebug(
  state: GoogleSheetRowScanState,
  options: {
    sheetTitle: string;
    indexed: boolean;
    leaf: boolean;
    parent: boolean;
    reason: string | null;
  },
): GoogleSheetRowIndexRowDebug {
  return {
    rowNumber: state.rowNumber,
    eventName: state.eventName,
    normalizedEventName: state.normalizedEventName,
    range: buildA1Range(
      options.sheetTitle,
      googleSheetCheckboxColumnIndex,
      state.rowNumber,
    ),
    leaf: options.leaf,
    parent: options.parent,
    gValue: state.gValue,
    actualColumns: state.actualColumns,
    indexed: options.indexed,
    reason: options.reason,
  };
}

function buildGoogleSheetRowIndexFromValues(
  values: unknown[][],
  options: {
    spreadsheetId: string;
    sheetTitle: string;
    range: string;
  },
): GoogleSheetRowIndexResult {
  const byEventName = new Map<
    string,
    {
      eventName: string;
      normalizedEventName: string;
      rowNumbers: number[];
      rawRows: string[][];
      rowDetails: GoogleSheetRowIndexRowDebug[];
    }
  >();
  const debugRows: GoogleSheetRowIndexRowDebug[] = [];
  const states = buildGoogleSheetRowScanStates(values);

  const addEventIndexEntry = (
    state: GoogleSheetRowScanState,
    rowDebug: GoogleSheetRowIndexRowDebug,
  ) => {
    const { eventName, normalizedEventName, rowNumber, row } = state;
    if (!eventName || !normalizedEventName || rowNumber <= 0) {
      return;
    }
    const normalizedParts = normalizedEventName.split(".").filter(Boolean);
    if (normalizedParts.length < 2) {
      return;
    }
    const current =
      byEventName.get(normalizedEventName) ?? {
        eventName,
        normalizedEventName,
        rowNumbers: [],
        rawRows: [],
        rowDetails: [],
      };
    if (!current.rowNumbers.includes(rowNumber)) {
      current.rowNumbers.push(rowNumber);
      current.rawRows.push(row);
      current.rowDetails.push(rowDebug);
    }
    byEventName.set(normalizedEventName, current);
  };

  for (const [stateIndex, state] of states.entries()) {
    const hasChildren = isGoogleSheetParentRow(states, stateIndex);
    const simpleBLeaf =
      state.hasActualBCell &&
      state.eventParts.length === 2 &&
      !hasChildren;
    const leaf =
      !hasChildren && (state.hasActualLeafCellInCtoE || simpleBLeaf);
    const parent = hasChildren && state.actualColumnIndexes.length > 0;
    const canIndex =
      state.eventParts.length >= 2 &&
      state.normalizedEventName.length > 0 &&
      leaf;

    if (canIndex) {
      const rowDebug = createGoogleSheetRowDebug(state, {
        sheetTitle: options.sheetTitle,
        indexed: true,
        leaf: true,
        parent: false,
        reason: null,
      });
      debugRows.push(rowDebug);
      addEventIndexEntry(state, rowDebug);
      console.log(
        `[googleRowIndex] indexed row=${state.rowNumber} event=${state.eventName} range=${rowDebug.range} gValue=${state.gValue}`,
      );
      if (!state.gValue) {
        console.warn(
          `[googleRowIndex] indexed leaf with empty checkbox cell row=${state.rowNumber} event=${state.eventName}`,
        );
      }
      continue;
    }

    if (parent && state.normalizedEventName) {
      const rowDebug = createGoogleSheetRowDebug(state, {
        sheetTitle: options.sheetTitle,
        indexed: false,
        leaf: false,
        parent: true,
        reason: "parent row",
      });
      debugRows.push(rowDebug);
      console.log(
        `[googleRowIndex] skipped parent row=${state.rowNumber} event=${state.eventName} actualColumns=${
          state.actualColumns.join(",") || "none"
        } gValue=${state.gValue}`,
      );
    }
  }

  const entries = [...byEventName.values()].sort((a, b) =>
    a.normalizedEventName.localeCompare(b.normalizedEventName),
  );
  return {
    spreadsheetId: options.spreadsheetId,
    sheetTitle: options.sheetTitle,
    range: options.range,
    cacheVersion: googleSheetRowIndexCacheVersion,
    rowCount: values.length,
    indexedEventCount: entries.length,
    entries,
    debugRows,
  };
}

function rowIndexCacheKey(spreadsheetId: string, sheetTitle: string): string {
  return `${spreadsheetId}\0${sheetTitle}\0${googleSheetRowIndexCacheVersion}`;
}

function findGoogleSheetRowIndexDebugRow(
  rowIndex: GoogleSheetRowIndexResult,
  eventName: string,
): GoogleSheetRowIndexRowDebug | null {
  const normalizedEventName = normalizeGoogleSheetEventName(eventName);
  if (!normalizedEventName) {
    return null;
  }
  return (
    rowIndex.debugRows.find(
      (row) => row.normalizedEventName === normalizedEventName,
    ) ?? null
  );
}

function formatGoogleSheetRowIndexDebugLine(
  rowIndex: GoogleSheetRowIndexResult,
  eventName: string,
): string {
  const normalizedEventName = normalizeGoogleSheetEventName(eventName);
  const debugRow = findGoogleSheetRowIndexDebugRow(rowIndex, eventName);
  const match = rowIndex.entries.find(
    (entry) => entry.normalizedEventName === normalizedEventName,
  );
  const row =
    match?.rowNumbers.length === 1
      ? match.rowNumbers[0]
      : debugRow?.rowNumber ?? null;
  const range =
    debugRow?.range ??
    (row !== null
      ? buildA1Range(rowIndex.sheetTitle, googleSheetCheckboxColumnIndex, row)
      : "null");
  return `${eventName} -> ${row ?? "null"} -> ${range} -> leaf=${
    debugRow?.leaf ?? Boolean(match)
  } -> parent=${debugRow?.parent ?? false} -> gValue=${
    debugRow?.gValue || "null"
  }`;
}

function logGoogleRowIndexDiagnostics(rowIndex: GoogleSheetRowIndexResult): void {
  console.log(
    `[googleRowIndex] sheetTitle=${rowIndex.sheetTitle} rowsRead=${rowIndex.rowCount} indexSize=${rowIndex.indexedEventCount}`,
  );
  for (const eventName of googleRowIndexDiagnosticEvents) {
    const match = rowIndex.entries.find(
      (entry) =>
        entry.normalizedEventName === normalizeGoogleSheetEventName(eventName),
    );
    const row =
      match?.rowNumbers.length === 1 ? match.rowNumbers[0] : null;
    console.log(
      `[googleSheetRowIndex] expected event=${eventName} rowNumbers=${JSON.stringify(
        match?.rowNumbers ?? [],
      )}`,
    );
    console.log(
      `[googleRowIndex] has ${eventName}=${Boolean(match)} row=${
        row ?? "null"
      }`,
    );
    console.log(
      `[googleRowIndex] sample ${formatGoogleSheetRowIndexDebugLine(
        rowIndex,
        eventName,
      )}`,
    );
  }
}

export async function buildGoogleSheetRowIndex(
  spreadsheetId: string,
  sheetTitle: string,
  accessToken: string,
  options: { force?: boolean; updateCount?: number } = {},
): Promise<GoogleSheetRowIndexResult> {
  const title = sheetTitle.trim();
  if (!spreadsheetId.trim() || !title) {
    throw new GoogleSheetSyncError(
      "Missing spreadsheetId or sheet tab name.",
      400,
      "Missing spreadsheetId or sheet tab name.",
    );
  }

  const cacheKey = rowIndexCacheKey(spreadsheetId, title);
  console.log(`[googleRowIndex] cacheVersion=${googleSheetRowIndexCacheVersion}`);
  const cached = googleSheetRowIndexCache.get(cacheKey);
  if (cached && !options.force) {
    logGoogleRowIndexDiagnostics(cached);
    return cached;
  }

  const range = buildA1ColumnRange(title, "A", "Z");
  const endpointUrl = getValuesUrl(spreadsheetId, range);
  console.log(`[googleSheetRowIndex] endpoint=${safeEndpointUrl(endpointUrl)}`);
  console.log(`[googleSheetRowIndex] range=${range}`);
  const tokenStatus = getGoogleAuthStatus();
  const payload = await googleFetchJson<{ values?: unknown[][] }>(endpointUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
    spreadsheetId,
    updateCount: options.updateCount ?? 0,
    accessTokenExists: Boolean(accessToken),
    accessTokenLength: accessToken.length,
    refreshTokenExists: tokenStatus.refreshTokenExists,
    fallbackToHttpsOnFetchError: true,
    logPrefix: "googleSheetSync",
  });
  const rowIndex = buildGoogleSheetRowIndexFromValues(payload.values ?? [], {
    spreadsheetId,
    sheetTitle: title,
    range,
  });
  googleSheetRowIndexCache.set(cacheKey, rowIndex);
  console.log(
    `[googleSheetRowIndex] rowCount=${rowIndex.rowCount} indexedEventCount=${rowIndex.indexedEventCount}`,
  );
  console.log(
    `[googleRowIndex] build success mappedEvents=${rowIndex.indexedEventCount}`,
  );
  logGoogleRowIndexDiagnostics(rowIndex);
  return rowIndex;
}

async function syncPassedRowsWithAccessToken(
  request: GoogleSheetSyncRequest,
  updates: GoogleSheetPassedUpdate[],
  accessToken: string,
): Promise<GoogleSheetSyncResult> {
  const writeSheetTitle = getGoogleSheetWriteTitle(request);
  if (writeSheetTitle === null) {
    throw new GoogleSheetSyncError(
      "Sheet/range not found",
      400,
      "Missing Google Sheet tab name. Enter Sheet tab name.",
    );
  }

  console.log(`[googleSheetSync] spreadsheetId=${request.spreadsheetId}`);
  console.log(`[googleSheetSync] gid=${request.gid || "null"}`);
  console.log("[googleSheetSync] writeMode=A1 batchUpdate");
  console.log(`[googleSheetSync] sheetTitle=${request.sheetTitle ?? "null"}`);
  console.log(
    `[googleSheetSync] manualSheetTitle=${request.manualSheetTitle ?? "null"}`,
  );
  console.log(`[googleSheetSync] writeSheetTitle=${writeSheetTitle}`);
  const batchUpdates = updates.slice(0, googleSheetsBatchUpdateSize);
  const isTestWrite =
    request.debugLabel === "testWrite" ||
    request.debugLabel === "exactG69" ||
    request.debugLabel === "exactG69A1" ||
    request.debugLabel === "exactG85" ||
    request.debugLabel === "exactG85A1";
  const testWriteUpdate = batchUpdates[0] ?? null;
  if (isTestWrite) {
    const checkboxColumnIndex = asColumnIndex(
      testWriteUpdate?.checkboxColumnIndex ?? null,
    );
    console.log("[googleSheetTestWrite] clicked");
    console.log(`[googleSheetTestWrite] hasPassedRows=${Boolean(testWriteUpdate)}`);
    console.log(
      `[googleSheetTestWrite] selectedRowId=${
        testWriteUpdate?.rowId ?? "null"
      }`,
    );
    console.log(
      `[googleSheetTestWrite] eventName=${
        testWriteUpdate?.eventName ?? ""
      }`,
    );
    console.log(
      `[googleSheetTestWrite] sourceRowNumber=${
        testWriteUpdate?.rowNumber ?? "null"
      }`,
    );
    console.log(`[googleSheetTestWrite] spreadsheetId=${request.spreadsheetId}`);
    console.log(`[googleSheetTestWrite] gid=${request.gid}`);
    console.log("[googleSheetTestWrite] writeMode=A1 batchUpdate");
    console.log(
      `[googleSheetTestWrite] sheetTitle=${request.sheetTitle ?? "null"}`,
    );
    console.log(
      `[googleSheetTestWrite] manualSheetTitle=${
        request.manualSheetTitle ?? "null"
      }`,
    );
    console.log(
      `[googleSheetTestWrite] checkboxColumnIndex=${
        checkboxColumnIndex ?? "null"
      }`,
    );
    console.log(
      `[googleSheetTestWrite] checkboxColumnLetter=${
        columnIndexToA1(checkboxColumnIndex)
      }`,
    );
  }
  const data: Array<{
    range: string;
    values: unknown[][];
  }> = [];
  const ranges: string[] = [];

  const addA1Update = (
    update: GoogleSheetPassedUpdate,
    rowNumber: number,
    columnIndex: number,
    values: unknown[][],
  ) => {
    const range = buildA1Range(writeSheetTitle, columnIndex, rowNumber);
    console.log(`[googleSheetSync] update rowId=${update.rowId}`);
    console.log(`[googleSheetSync] eventName=${update.eventName ?? ""}`);
    console.log(`[googleSheetSync] rowNumber=${rowNumber}`);
    console.log(`[googleSheetSync] columnIndex=${columnIndex}`);
    console.log(`[googleSheetSync] range=${range}`);
    console.log(`[googleSheetSync] values=${JSON.stringify(values)}`);
    ranges.push(range);
    data.push({
      range,
      values,
    });
  };

  for (const update of batchUpdates) {
    const checkboxColumnIndex = asColumnIndex(
      update.checkboxColumnIndex ?? null,
    );
    const statusColumnIndex = asColumnIndex(update.statusColumnIndex ?? null);
    console.log(`[googleSheetSync] checkboxColumnIndex=${checkboxColumnIndex}`);
    console.log(`[googleSheetSync] statusColumnIndex=${statusColumnIndex}`);

    if (checkboxColumnIndex !== null) {
      console.log("[googleSheetSync] value=true");
      addA1Update(
        update,
        update.rowNumber,
        checkboxColumnIndex,
        [[true]],
      );
    }
  }

  const endpointUrl = getBatchUpdateUrl(request.spreadsheetId);
  console.log(`[googleSheetSync] endpoint=${safeEndpointUrl(endpointUrl)}`);
  const requestBody = {
    valueInputOption: "USER_ENTERED",
    data,
  };
  const body = JSON.stringify(requestBody);
  console.log(`[googleSheetSync] ranges=${JSON.stringify(ranges)}`);
  console.log(`[googleSheetSync] dataCount=${data.length}`);
  console.log(`[googleSheetSync] requestBody=${body}`);
  console.log(`[googleSheetSync] body=${JSON.stringify(requestBody, null, 2)}`);
  if (isTestWrite) {
    console.log(`[googleSheetTestWrite] endpoint=${safeEndpointUrl(endpointUrl)}`);
    console.log(`[googleSheetTestWrite] range=${ranges[0] ?? "null"}`);
    console.log(
      `[googleSheetTestWrite] body=${JSON.stringify(requestBody, null, 2)}`,
    );
  }
  console.log("[googleSheetSync] batchUpdate request", {
    endpointUrl: safeEndpointUrl(endpointUrl),
    accessTokenExists: Boolean(accessToken),
    requestedUpdateCount: updates.length,
    sentUpdateCount: batchUpdates.length,
    dataRangeCount: data.length,
    ranges,
  });

  let apiStatus: number | null = null;
  let apiResponse = "";
  try {
    await googleFetchJson(endpointUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body,
      spreadsheetId: request.spreadsheetId,
      updateCount: batchUpdates.length,
      accessTokenExists: Boolean(accessToken),
      accessTokenLength: accessToken.length,
      refreshTokenExists: getGoogleAuthStatus().refreshTokenExists,
      fallbackToHttpsOnFetchError: true,
      timeoutMs: googleSheetsWritebackRequestTimeoutMs,
      fallbackTimeoutMs: googleSheetsHttpsFallbackRequestTimeoutMs,
      onResponse: (response) => {
        apiStatus = response.status;
        apiResponse = response.text;
      },
    });
  } catch (error) {
    if (isTestWrite) {
      logGoogleSheetTestWriteFailure(error);
    }
    throw error;
  }
  const batchDebug = parseBatchUpdateDebug(apiResponse);
  console.log(`[googleSheetSync] totalUpdatedCells=${batchDebug.totalUpdatedCells}`);
  console.log(`[googleSheetSync] totalUpdatedRows=${batchDebug.totalUpdatedRows}`);
  console.log(`[googleSheetSync] updatedData=${JSON.stringify(batchDebug.updatedData)}`);
  if (isTestWrite) {
    console.log(`[googleSheetTestWrite] response.status=${apiStatus}`);
    console.log(`[googleSheetTestWrite] response body=${apiResponse}`);
    console.log(
      `[googleSheetTestWrite] totalUpdatedCells=${batchDebug.totalUpdatedCells}`,
    );
    console.log(
      `[googleSheetTestWrite] totalUpdatedRows=${batchDebug.totalUpdatedRows}`,
    );
    console.log(
      `[googleSheetTestWrite] updatedData=${JSON.stringify(
        batchDebug.updatedData,
      )}`,
    );
  }
  console.log(
    `[googleSheetSync] updatedRowIds=${JSON.stringify(
      batchUpdates.map((update) => update.rowId),
    )}`,
  );

  return {
    updatedRanges: data.length,
    updatedRowIds: batchUpdates.map((update) => update.rowId),
    pendingUpdateCount: updates.length - batchUpdates.length,
    endpoint: safeEndpointUrl(endpointUrl),
    requestBody,
    writeMode: "A1 batchUpdate",
    ranges,
    apiStatus,
    apiResponse,
    totalUpdatedCells: batchDebug.totalUpdatedCells,
    totalUpdatedRows: batchDebug.totalUpdatedRows,
    updatedData: batchDebug.updatedData,
    warning:
      isTestWrite && apiStatus === 200
        ? "Google API accepted update but visible sheet did not change. Check target row/column."
        : null,
  };
}

export async function syncPassedRowsToGoogleSheet(
  request: GoogleSheetSyncRequest,
): Promise<GoogleSheetSyncResult> {
  if (!request.spreadsheetId.trim()) {
    throw new GoogleSheetSyncError(
      "Sheet/range not found",
      400,
      "Missing spreadsheetId",
    );
  }

  const updates = request.updates.filter(
    (update) =>
      Number.isInteger(update.rowNumber) &&
      update.rowNumber > 0 &&
      asColumnIndex(update.checkboxColumnIndex ?? null) !== null,
  );

  if (updates.length === 0) {
    throw new GoogleSheetSyncError(
      "Sheet/range not found",
      400,
      "No rows with checkbox columns to update",
    );
  }

  let accessToken: string;
  try {
    accessToken = await getGoogleSheetsAccessToken();
  } catch (e) {
    if (e instanceof GoogleOAuthNetworkError) {
      throw new GoogleSheetSyncError(
        "Sheet sync: network issue, will retry",
        503,
        e.technicalDetail ?? e.message,
        true,
        undefined,
        getGoogleErrorDebug(e),
      );
    }
    throw new GoogleSheetSyncError(
      "Google access token is missing. Reconnect Google.",
      401,
      e instanceof Error ? e.message : String(e),
    );
  }

  try {
    try {
      return await syncPassedRowsWithAccessToken(request, updates, accessToken);
    } catch (e) {
      if (!(e instanceof GoogleSheetSyncError) || e.status !== 401) {
        throw e;
      }

      try {
        accessToken = await refreshGoogleSheetsAccessToken();
      } catch (refreshError) {
        if (refreshError instanceof GoogleOAuthNetworkError) {
          throw new GoogleSheetSyncError(
            "Sheet sync: network issue, will retry",
            503,
            refreshError.technicalDetail ?? refreshError.message,
            true,
            undefined,
            getGoogleErrorDebug(refreshError),
          );
        }
        throw new GoogleSheetSyncError(
          "Google access token is missing. Reconnect Google.",
          401,
          refreshError instanceof Error
            ? refreshError.message
            : String(refreshError),
        );
      }

      return syncPassedRowsWithAccessToken(request, updates, accessToken);
    }
  } catch (e) {
    if (e instanceof GoogleSheetSyncError) {
      throw e;
    }
    throw new GoogleSheetSyncError(
      "Network error",
      502,
      e instanceof Error ? e.message : String(e),
    );
  }
}
