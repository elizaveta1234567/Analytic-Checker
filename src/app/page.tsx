"use client";

import {
  applyMatchToRows,
  buildMatcherIndexes,
  computeStats,
  extractAnalyticsPayload,
  matchLogLinesAgainstSpec,
  matchPayload,
  normalizeAnalyticsEventCandidate,
  normalizeValue,
  parseWorkbookToMatrix,
  validateExtractedPayload,
  type MatcherStats,
  type ParsedLogEntry,
  type ParsedSpecResult,
} from "@/lib/analytics";
import { importSpecFromMatrix } from "@/lib/analytics/import";
import { exportCheckedWorkbook } from "@/lib/analytics/import/exportCheckedWorkbook";
import type { AnalyticsSpecRow } from "@/lib/analytics/types";
import {
  AnalyticsTable,
  CoverageSummary,
  LogPanel,
  Sidebar,
  StatsBar,
} from "@/components/analytics";
import type { StatsBarCounts } from "@/components/analytics/StatsBar";
import { StatusDot } from "@/components/analytics/StatusDot";
import type { StatusDotVariant } from "@/components/analytics/StatusDot";
import type {
  SidebarFilter,
  SidebarSheetSyncStatus,
} from "@/components/analytics/Sidebar";
import {
  specToTableRowModel,
  type TableRowModel,
} from "@/components/analytics/specRowDisplay";
import { appBuildInfo } from "@/lib/buildInfo";
import { parseIosLunarConsoleLogLine } from "@/lib/lunar-console/logParser";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type AndroidLiveStatus =
  | "disconnected"
  | "connecting"
  | "live"
  | "error";

type PlatformMode = "android" | "ios" | "unity";

function platformUsesSdkEventGroupTabs(platform: PlatformMode): boolean {
  return platform === "unity" || platform === "ios";
}

type AndroidEventGroupTabId =
  | "all"
  | "subscription"
  | "tracking_confirmed"
  | "inapp"
  | "tracking_purchase"
  | "funnel";
type UnityEventGroupTabId = "all" | "appmetrica" | "appsflyer" | "ab_test";
type EventGroupTabId = AndroidEventGroupTabId | UnityEventGroupTabId;

const androidPackageNamesStorageKey = "analytics-checker.androidPackageNames";
const uiLanguageStorageKey = "analytics-checker.uiLanguage";
const themeStorageKey = "analytics-checker.theme";
const googleAuthPendingMessage = "Complete Google sign-in in the browser.";
const googleAuthPollingIntervalMs = 1500;
const googleAuthPollingTimeoutMs = 60000;
const googleSheetSyncBatchSize = 1;
const googleSheetSyncDebounceMs = 500;
const googleSheetSyncDefaultDelayMs = googleSheetSyncDebounceMs;
const googleSheetSyncRetryDelayMs = [2000, 5000, 10000, 25000] as const;
const googleSheetImportRetryDelayMs = [5000, 15000, 30000] as const;
const googleSheetSyncRequestTimeoutMs = 240000;
const googleSheetSyncRequestTimeoutSeconds = Math.round(
  googleSheetSyncRequestTimeoutMs / 1000,
);
const googleSheetImportSlowHintDelayMs = 20000;
const googleSheetImportStillRunningHintDelayMs = 60000;
const googleSheetRowIndexRequestTimeoutMs = 20000;
const googleSheetSyncStaleInFlightMs = googleSheetSyncRequestTimeoutMs + 5000;
const unityLiveConnectTimeoutMs = 10000;
const duplicateWindowMs = 1500;
const fixedGoogleSheetCheckboxColumnIndex = 6;
const fixedGoogleSheetCheckboxColumnLetter = "G";
const defaultAndroidGoogleSheetTabName = "Analytics_GooglePlay";
const defaultIosGoogleSheetTabName = "Analytics_iOS";
const defaultUnityGoogleSheetTabName = "Analytics_Unity";
const googleSheetHierarchyColumnCount = 5;
const googleSheetLeafColumnStartIndex = 2;
const googleSheetLeafColumnEndIndex = 4;
const googleSheetRowIndexCacheVersion = "v4";

type UiLanguage = "en" | "ru";
type AppTheme = "dark" | "light";

type GoogleAuthStatus = {
  configured: boolean;
  connected: boolean;
};

type SheetSyncStatus = "idle" | "pending" | "syncing" | "synced" | "failed";
type GoogleRowIndexStatus = "idle" | "building" | "ready" | "failed";
type SheetTitleSource = "auto-detected" | "manual" | "default";
type GoogleSheetImportErrorType =
  | "network"
  | "access"
  | "invalid-url"
  | "unknown";

type GoogleSheetImportErrorDebug = {
  importErrorType: GoogleSheetImportErrorType;
  importTechnicalDetail: string | null;
};

type GoogleSheetRowIndexRebuildOptions = {
  scheduleSyncAfter?: boolean;
  scheduleRetryOnNetwork?: boolean;
  resetRetryAttempt?: boolean;
};

type GoogleSheetSourceRow = {
  rowId: string;
  sourceRowIndex: number;
  sourceRowNumber: number;
  importedIndex?: number;
  eventName?: string;
  normalizedEventName?: string;
  googleCheckRange?: string | null;
  sourcePathColumns?: string[];
  rawRow?: string[];
};

type GoogleSheetStaircaseRow = {
  sourceRowIndex: number;
  sourceRowNumber: number;
  rawRow?: string[];
};

type GoogleSheetCheckboxCandidate = {
  columnIndex: number;
  count: number;
  dataValidationCount: number;
  boolValueCount: number;
  header: string;
};

type GoogleSheetSyncMetadata = {
  spreadsheetId: string;
  gid: string;
  sourceUrl: string;
  writebackSource?: "googleSheetImport" | "uploadedXlsx";
  selectedPlatform?: PlatformMode | string;
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
  sheetTitleSource?: SheetTitleSource;
  sheetTitleResolutionError?: string | null;
  checkboxColumnIndex?: number | null;
  statusColumnIndex?: number | null;
  checkboxCandidates?: GoogleSheetCheckboxCandidate[];
  checkboxColumnDetectionError?: string | null;
  checkboxColumnSource?: "metadata" | "manual" | "fixed" | null;
  detectedHeaders?: string[];
  headerRowIndex?: number | null;
  headerRowNumber?: number | null;
  doneColumnIndex: number | null;
  checkColumnIndex: number | null;
  rows: GoogleSheetSourceRow[];
  staircaseRows?: GoogleSheetStaircaseRow[];
};

type AutoUpdateGoogleSheetDisabledReason = string;

type GoogleSheetWritebackTargetSource =
  | "googleSheetImportStaircaseIndex"
  | "uploadedXlsxStaircaseIndex";

type PendingGoogleSheetUpdate = {
  rowId: string;
  eventName: string;
  status: "passed";
  matchedRowId?: string;
  sourceRowNumber?: number | null;
  range?: string | null;
  source?: GoogleSheetWritebackTargetSource;
};

type SkippedGoogleSheetWriteback = {
  rowId: string;
  eventName: string;
  normalizedEventName: string;
  reason: string;
  candidates: string;
  skippedAt: number;
};

type GoogleSheetWritebackLookupFailure = {
  eventName: string;
  normalizedEventName: string;
  rowId: string;
  matchedRowId: string | null;
  pendingUpdate: PendingGoogleSheetUpdate;
  rowIndexStatus: GoogleRowIndexStatus;
  rowIndexMappedEventsCount: number;
  candidates: string;
  reason: string;
  occurredAt: number;
};

type UnknownLiveResult = {
  id: string;
  logId: string;
  eventName: string;
  normalizedEventName: string;
  reason: string;
  analyticsType?: string | null;
  analyticsSource?: string | null;
  timestamp: number;
  lastSeenAt: number;
  count: number;
};

type LiveDuplicateSeen = {
  lastSeenAt: number;
  lastResultType: ParsedLogEntry["matchType"];
};

type ManualGoogleSheetSyncSettings = {
  tabKey: string | null;
  manualSheetTitle: string | null;
  sheetTitleSource?: SheetTitleSource | null;
  manualCheckboxColumnInput: string;
  checkboxColumnSource: "manual" | "fixed" | null;
};

type GoogleSheetPassedRowTarget = {
  rowId: string;
  eventName: string;
};

type GoogleSheetRowIndexEntry = {
  eventName: string;
  normalizedEventName: string;
  rowNumbers: number[];
  source?: GoogleSheetWritebackTargetSource;
  rawRows?: string[][];
  rowDetails?: GoogleSheetRowIndexRowDebug[];
};

type GoogleSheetRowIndexRowDebug = {
  rowNumber: number;
  eventName: string;
  normalizedEventName: string;
  range: string | null;
  leaf: boolean;
  parent: boolean;
  gValue: string;
  gIsBooleanLike: boolean;
  actualColumns: string[];
  rawRow?: string[];
  indexed: boolean;
  reason: string | null;
  source?: GoogleSheetWritebackTargetSource;
};

type GoogleSheetRowIndexWriteTarget = {
  rowNumber: number | null;
  reason: string | null;
  candidates: string;
  debugRow: GoogleSheetRowIndexRowDebug | null;
};

type GoogleSheetWriteTargetResolution = {
  rowNumber: number | null;
  range: string | null;
  source: GoogleSheetWritebackTargetSource | null;
  reason: string | null;
  candidates: string;
  debugRow: GoogleSheetRowIndexRowDebug | null;
};

type GoogleSheetRowIndexState = {
  spreadsheetId: string;
  sheetTitle: string;
  range: string;
  cacheVersion?: string;
  source?: GoogleSheetWritebackTargetSource;
  rowCount: number;
  indexedEventCount: number;
  entries: GoogleSheetRowIndexEntry[];
  debugRows?: GoogleSheetRowIndexRowDebug[];
  builtAt: number;
};

type MatchBundleState = {
  logs: ParsedLogEntry[];
  rows: AnalyticsSpecRow[];
  stats: MatcherStats;
};

type PlatformWorkspaceState = {
  importResult: ParsedSpecResult | null;
  originalWorkbookBuffer: ArrayBuffer | null;
  selectedRowId: string | null;
  importError: string | null;
  googleSheetUrl: string;
  googleSheetError: string | null;
  lastXlsxImportDebugInfo: string | null;
  googleSheetImportInfo: string | null;
  googleSheetImportErrorDebug: GoogleSheetImportErrorDebug | null;
  googleSheetSourceUrl: string | null;
  googleSheetSyncMeta: GoogleSheetSyncMetadata | null;
  manualSheetTitleInput: string;
  manualCheckboxColumnInput: string;
  manualCheckboxColumnError: string | null;
  manualGoogleSheetSyncSettings: ManualGoogleSheetSyncSettings;
  autoUpdateGoogleSheet: boolean;
  previewGoogleSheetWriteTargets: boolean;
  googleSheetWriteTargetPreview: string[];
  googleSheetRowIndex: GoogleSheetRowIndexState | null;
  unknownLiveResults: UnknownLiveResult[];
  matchBundle: MatchBundleState | null;
  logText: string;
  unityManualEventInput: string;
  iosLunarConsoleInput: string;
  processMessage: string | null;
  activeSidebarFilter: SidebarFilter;
  activeEventGroupTab: EventGroupTabId;
  liveDuplicateSeenByEventName: Map<string, LiveDuplicateSeen>;
  pendingSheetUpdates: Map<string, PendingGoogleSheetUpdate>;
  skippedGoogleSheetWritebacks: SkippedGoogleSheetWriteback[];
  syncedGoogleSheetRowIds: Set<string>;
  sheetSyncSeenLogIds: Set<string>;
  pendingSheetUpdateCount: number;
  sheetSyncStatus: SheetSyncStatus;
  sheetSyncError: string | null;
  sheetSyncStartedAt: number | null;
  lastSheetSyncAttemptAt: number | null;
  lastSheetSyncFinishedAt: number | null;
  lastGoogleSheetSyncStatus: "success" | "failed" | null;
  lastGoogleSheetSyncUpdatedRows: string[];
  lastGoogleSheetSyncRanges: string[];
  lastGoogleSheetSyncApiStatus: number | null;
  lastGoogleSheetSyncTotalUpdatedCells: number | null;
  lastGoogleSheetSyncTotalUpdatedRows: number | null;
  lastGoogleSheetMappingDebugInfo: string | null;
  googleRowIndexStatus: GoogleRowIndexStatus;
  googleRowIndexLastError: string | null;
  lastWritebackLookupFailure: GoogleSheetWritebackLookupFailure | null;
};

type GoogleSheetRowIndexResponse =
  | ({
      success: true;
      spreadsheetId: string;
      sheetTitle: string;
      range: string;
      cacheVersion?: string;
      rowCount: number;
      indexedEventCount: number;
      source?: GoogleSheetWritebackTargetSource;
      entries: GoogleSheetRowIndexEntry[];
      debugRows?: GoogleSheetRowIndexRowDebug[];
      error?: never;
      technicalDetail?: never;
      networkIssue?: never;
    })
  | {
      success: false;
      error?: string;
      technicalDetail?: string;
      networkIssue?: boolean;
    };

type SettingsPopoverPosition = {
  left: number;
  top: number;
};

type GoogleSheetImportResponse =
  | {
      success: true;
      result: ParsedSpecResult;
      workbookBase64: string;
      sourceUrl: string;
      spreadsheetId: string;
      gid: string;
      sync?: GoogleSheetSyncMetadata;
    }
  | {
      success: false;
      error?: string;
      technicalDetail?: string;
      importErrorType?: GoogleSheetImportErrorType;
      networkIssue?: boolean;
    };

type UnityLiveStartResponse = {
  success?: boolean;
  status?: AndroidLiveStatus;
  logPath?: string | null;
  resolvedLogPath?: string | null;
  logFileName?: string | null;
  logSourceType?: "editor" | "player" | "custom" | null;
  detectedProjectPath?: string | null;
  detectedProductName?: string | null;
  logFileExists?: boolean | null;
  watcherStarted?: boolean;
  lastError?: string | null;
  lastLineAt?: number | null;
  analyticsEventsSeenCount?: number;
  rawLinesSeenCount?: number;
  analyticsCandidateLinesCount?: number;
  lastRawLineAt?: number | null;
  initialTailRead?: boolean;
  initialTailLinesCount?: number;
  lastRawLine?: string | null;
  lastExtractedEvent?: string | null;
  lastExtractedAnalyticsType?: "AppsFlyer" | "AppMetrica" | "ABTest" | null;
  tailMode?: "watcher" | "polling" | "both" | null;
  bufferedCount?: number;
  error?: string;
  errorCode?: string | null;
};

type UnityLiveStreamEntry = {
  rawLine: string;
  analyticsLine: string | null;
  timestamp?: number;
  extractedEvent?: string | null;
  analyticsType?: "AppsFlyer" | "AppMetrica" | "ABTest" | null;
  detectedProjectPath?: string | null;
  detectedProductName?: string | null;
};

type UnityLiveFeedLine = {
  id: string;
  text: string;
  rawLine: string;
  analyticsLine: string | null;
};

type LiveAnalyticsLineOptions = {
  allowSingleSegmentPayload?: boolean;
  analyticsType?: "AppsFlyer" | "AppMetrica" | "ABTest" | null;
  analyticsSource?: string | null;
};

type GoogleSheetImportClientRequest = {
  requestId: number;
  controller: AbortController;
  slowHintTimerId: number | null;
  stillRunningHintTimerId: number | null;
};

type GoogleSheetCheckboxColumnsResponse =
  | ({
      success: true;
      checkboxColumnIndex: number | null;
      checkboxCandidates: GoogleSheetCheckboxCandidate[];
      checkboxColumnDetectionError: string | null;
      error?: string | null;
      technicalDetail?: never;
      networkIssue?: never;
    })
  | {
      success: false;
      error?: string;
      technicalDetail?: string;
      checkboxCandidates?: GoogleSheetCheckboxCandidate[];
      checkboxColumnDetectionError?: string;
      networkIssue?: boolean;
    };

type GoogleSheetSyncResponse = {
  success?: boolean;
  error?: string;
  technicalDetail?: string;
  networkIssue?: boolean;
  errorName?: string;
  errorMessage?: string;
  causeCode?: string;
  causeMessage?: string;
  attemptCount?: number | null;
  attempts?: GoogleSheetNetworkAttemptDebug[];
  updatedRowIds?: unknown;
  endpoint?: string;
  requestBody?: unknown;
  writeMode?: string;
  ranges?: unknown;
  apiStatus?: number | null;
  apiResponse?: string;
  totalUpdatedCells?: number | null;
  totalUpdatedRows?: number | null;
  updatedData?: unknown;
  warning?: string | null;
};

type GoogleSheetNetworkAttemptDebug = {
  attempt: number;
  maxAttempts: number;
  transport: string;
  errorName: string | null;
  errorMessage: string | null;
  causeCode: string | null;
  causeMessage: string | null;
  technicalDetail: string;
};

function createDefaultManualGoogleSheetSyncSettings(): ManualGoogleSheetSyncSettings {
  return {
    tabKey: null,
    manualSheetTitle: null,
    sheetTitleSource: null,
    manualCheckboxColumnInput: fixedGoogleSheetCheckboxColumnLetter,
    checkboxColumnSource: "fixed",
  };
}

function createDefaultPlatformWorkspaceState(): PlatformWorkspaceState {
  return {
    importResult: null,
    originalWorkbookBuffer: null,
    selectedRowId: null,
    importError: null,
    googleSheetUrl: "",
    googleSheetError: null,
    lastXlsxImportDebugInfo: null,
    googleSheetImportInfo: null,
    googleSheetImportErrorDebug: null,
    googleSheetSourceUrl: null,
    googleSheetSyncMeta: null,
    manualSheetTitleInput: "",
    manualCheckboxColumnInput: fixedGoogleSheetCheckboxColumnLetter,
    manualCheckboxColumnError: null,
    manualGoogleSheetSyncSettings: createDefaultManualGoogleSheetSyncSettings(),
    autoUpdateGoogleSheet: false,
    previewGoogleSheetWriteTargets: false,
    googleSheetWriteTargetPreview: [],
    googleSheetRowIndex: null,
    unknownLiveResults: [],
    matchBundle: null,
    logText: "",
    unityManualEventInput: "",
    iosLunarConsoleInput: "",
    processMessage: null,
    activeSidebarFilter: "all",
    activeEventGroupTab: "all",
    liveDuplicateSeenByEventName: new Map(),
    pendingSheetUpdates: new Map(),
    syncedGoogleSheetRowIds: new Set(),
    sheetSyncSeenLogIds: new Set(),
    skippedGoogleSheetWritebacks: [],
    pendingSheetUpdateCount: 0,
    sheetSyncStatus: "idle",
    sheetSyncError: null,
    sheetSyncStartedAt: null,
    lastSheetSyncAttemptAt: null,
    lastSheetSyncFinishedAt: null,
    lastGoogleSheetSyncStatus: null,
    lastGoogleSheetSyncUpdatedRows: [],
    lastGoogleSheetSyncRanges: [],
    lastGoogleSheetSyncApiStatus: null,
    lastGoogleSheetSyncTotalUpdatedCells: null,
    lastGoogleSheetSyncTotalUpdatedRows: null,
    lastGoogleSheetMappingDebugInfo: null,
    googleRowIndexStatus: "idle",
    googleRowIndexLastError: null,
    lastWritebackLookupFailure: null,
  };
}

function createDefaultPlatformWorkspaces(): Record<
  PlatformMode,
  PlatformWorkspaceState
> {
  return {
    android: createDefaultPlatformWorkspaceState(),
    ios: createDefaultPlatformWorkspaceState(),
    unity: createDefaultPlatformWorkspaceState(),
  };
}

const platformItems: Array<{ id: PlatformMode; label: string }> = [
  { id: "android", label: "Android" },
  { id: "ios", label: "iOS" },
  { id: "unity", label: "Unity" },
];

function AndroidPlatformIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-6 w-6"
      viewBox="0 0 24 24"
      fill="none"
    >
      <path
        d="M7.5 7.5 5.8 4.9M16.5 7.5l1.7-2.6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.7"
      />
      <path
        d="M6.5 10.5a5.5 5.5 0 0 1 11 0v6.2c0 .7-.6 1.3-1.3 1.3H7.8c-.7 0-1.3-.6-1.3-1.3v-6.2Z"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d="M4.5 11.5v4M19.5 11.5v4M9.5 18v2M14.5 18v2"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.7"
      />
      <path
        d="M10 11.3h.01M14 11.3h.01"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2.2"
      />
    </svg>
  );
}

function ApplePlatformIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-6 w-6"
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <path d="M15.8 3.1c.1 1.1-.3 2.1-1 2.9-.7.8-1.8 1.4-2.8 1.3-.1-1 .3-2.1 1-2.8.7-.8 1.8-1.4 2.8-1.4Z" />
      <path d="M19.2 16.8c-.4.9-.6 1.3-1.1 2.1-.7 1.1-1.7 2.5-3 2.5-1.1 0-1.4-.7-2.9-.7s-1.8.7-2.9.7c-1.3 0-2.3-1.3-3-2.4-2-3-2.2-6.6-1-8.5.8-1.4 2.1-2.2 3.4-2.2 1.3 0 2.1.7 3.2.7 1 0 1.7-.7 3.2-.7 1.1 0 2.4.6 3.2 1.7-2.8 1.5-2.4 5.5.9 6.8Z" />
    </svg>
  );
}

function UnityPlatformIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-6 w-6"
      viewBox="0 0 24 24"
      fill="none"
    >
      <path
        d="m12 3 7 4v10l-7 4-7-4V7l7-4Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
      <path
        d="m5.5 7.4 6.5 3.7 6.5-3.7M12 11.1V20"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
      <path
        d="m8.5 5.3 7 4M15.5 5.3l-7 4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.4"
      />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-[22px] w-[22px]"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    >
      <path
        d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.72l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z"
      />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function MoonThemeIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-5 w-5"
      viewBox="0 0 24 24"
      fill="none"
    >
      <path
        d="M20.3 14.5A7.8 7.8 0 0 1 9.5 3.7 8.2 8.2 0 1 0 20.3 14.5Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function SunThemeIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-5 w-5"
      viewBox="0 0 24 24"
      fill="none"
    >
      <path
        d="M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M18.4 5.6l1.4-1.4M4.2 19.8l1.4-1.4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

const pillToggleBase =
  "grid h-9 w-full grid-cols-2 rounded-full border border-[#2a2f3a] bg-[#171923] p-0.5";

const pillSegmentBase =
  "ui-btn ui-btn-sm ui-btn-full min-w-0 rounded-full px-2 text-[11px] uppercase";

const pillSegmentActive = "ui-btn-active";

const pillSegmentIdle = "ui-btn-ghost";

const sidebarIconButtonBase =
  "ui-btn ui-btn-icon shrink-0";

const sidebarIconButtonActive = "ui-btn-active";

const sidebarIconButtonIdle = "ui-btn-ghost";

const settingsPopoverWidthPx = 220;
const settingsPopoverHeightPx = 152;
const settingsPopoverViewportPaddingPx = 16;
const settingsPopoverOffsetPx = 12;

const androidEventGroupTabs: Array<{
  id: AndroidEventGroupTabId;
  label: string;
}> = [
  { id: "all", label: "All events" },
  { id: "subscription", label: "Subscription" },
  { id: "tracking_confirmed", label: "Tracking confirmed" },
  { id: "inapp", label: "In-app" },
  { id: "tracking_purchase", label: "Tracking purchase" },
  { id: "funnel", label: "Funnel" },
];

const unityEventGroupTabIds: UnityEventGroupTabId[] = [
  "all",
  "appmetrica",
  "appsflyer",
  "ab_test",
];

const androidEventGroupTabIdSet = new Set<string>(
  androidEventGroupTabs.map((tab) => tab.id),
);

const unityEventGroupTabIdSet = new Set<string>(unityEventGroupTabIds);

const statusFilterTabs: Array<{ id: SidebarFilter }> = [
  { id: "all" },
  { id: "passed" },
  { id: "duplicate" },
  { id: "unknown" },
  { id: "not_checked" },
];

const eventGroupPathByTab: Record<
  Exclude<AndroidEventGroupTabId, "all">,
  string
> = {
  subscription: "subscription",
  tracking_confirmed: "tracking.confirmed",
  inapp: "inapp",
  tracking_purchase: "tracking.purchase",
  funnel: "funnel",
};

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

const uiLabels = {
  en: {
    mode: "Mode",
    settings: "Settings",
    import: "Import",
    exportSectionTitle: "EXPORT",
    detachSpec: "Detach spec",
    detachSpecConfirm:
      "There are unsynced changes. Detach the spec and clear the queue?",
    importFailed: "Import failed",
    uploadSpec: "Upload spec",
    fileImportFallback: "Or import from file",
    reading: "Reading...",
    googleSheetUrlPlaceholder: "Google Sheet URL",
    googleSheetUrlHint:
      "Open the needed tab in Google Sheets and paste its full URL.",
    importGoogleSheet: "Import Google Sheet",
    importingGoogleSheet: "Importing...",
    googleConnected: "Google write sync: connected",
    googleNotConnected: "Google write sync: not configured",
    connectGoogle: "Connect Google",
    connectingGoogle: "Connecting...",
    autoUpdateGoogleSheet: "Auto-update Google Sheet",
    checkboxColumn: "Checkbox column",
    sheetTabName: "Sheet tab name",
    useColumn: "Use column",
    readOnlyMode:
      "Read-only import works. Connect Google only if you want to write Passed results back to the sheet.",
    sheetSync: "Sheet sync",
    google: {
      sheetUrlPlaceholder: "Google Sheet URL",
      sheetUrlHint:
        "Open the needed tab in Google Sheets and paste its full URL.",
      sheetUrlRequired: "Paste a valid Google Sheets URL.",
      invalidSheetUrl: "Invalid Google Sheet URL.",
      invalidSheetUrlSheetIdNotFound:
        "Invalid Google Sheet URL: sheetId not found.",
      invalidSheetUrlGidNotFound:
        "Invalid Google Sheet URL: gid not found.",
      importSheet: "Import Google Sheet",
      importedSheet: "Imported",
      importingSheet: "Importing...",
      importSlowHint:
        "Large sheet, import may take 1–2 minutes or longer...",
      importStillRunningHint: "Import is still running. Don’t close the app.",
      cancelImport: "Cancel import",
      importCancelled: "Import cancelled",
      importNetworkIssue:
        "Network issue. Could not import Google Sheet, please try again.",
      importNetworkRetry:
        "Network issue, will retry import automatically",
      importAccessDenied:
        "Could not import Google Sheet. Make sure the sheet is shared with view access.",
      useUploadedXlsxForGoogleSync: "Use uploaded XLSX for Google sync",
      uploadedXlsxGoogleSyncHint:
        "If Google Sheet import fails, download the tab as .xlsx and upload it below. Checkbox writeback will still use the Google Sheet URL.",
      uploadedXlsxGoogleSyncLoaded:
        "XLSX loaded, Google sync attached",
      xlsxSheetNotFound: (sheetName: string) =>
        `Sheet ${sheetName} was not found in the XLSX`,
      xlsxNoSpecRows: (sheetName: string) =>
        `No spec rows found in ${sheetName}`,
      importFailed:
        "Could not import Google Sheet. Make sure the sheet is shared with view access or published.",
      googleConnectionExpired:
        "Google connection expired. Connect Google again.",
      googleOAuthTimeout:
        "Google OAuth is taking too long to respond. Try reconnecting Google.",
      googleOAuthMisconfigured:
        "Google OAuth is misconfigured. Check GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET.",
      googleSheetAccessDenied: "No access to Google Sheet.",
      googleSheetNotFound: "Google Sheet or tab not found.",
      specLoaded: "Spec loaded",
      preparingSync: "Preparing sync...",
      syncReady: "Sync ready",
      writeSyncTitle: "Google Write Sync",
      connected: "Connected",
      notConnected: "Not connected",
      connect: "Connect Google",
      reconnect: "Reconnect Google",
      disconnect: "Disconnect",
      connecting: "Connecting...",
      autoUpdate: "Auto-update",
      importFirst: "Import Google Sheet first",
      sheetTabName: "Sheet tab name",
      sheetTabDetectedAutomatically: "Sheet tab detected automatically",
      checkboxColumn: "Checkbox column",
      overrideCheckboxColumn: "Override checkbox column",
      save: "Save",
      sheetSync: "Sheet sync",
      sheetSyncStatus: {
        idle: "idle",
        pending: "pending",
        syncing: "sending...",
        synced: "synced",
        failed: "failed",
      },
      sheetSyncPending: (count: number) => `pending ${count}`,
      lastSyncRows: (count: number) => `Last sync: ${count} rows`,
      debugDetails: "Debug details",
      noDebugDetails: "No debug details yet.",
      checkboxColumnSaved: (column: string) =>
        `Checkbox column saved: ${column}`,
      sheetTabSaved: (title: string) => `Sheet tab saved: ${title}`,
      invalidColumnLetter: "Invalid column letter.",
      sheetTabNameRequired: "Sheet tab name required",
      checkboxColumnNotFoundManual:
        "Checkbox column not found. Select it manually.",
      syncPendingNow: "Sync pending now",
      previewWriteTargets: "Preview write targets",
      previewNoWrites: "Preview write targets: no Google writes sent.",
      retryCheckboxDetection: "Retry checkbox detection",
      retryingCheckboxDetection: "Retrying checkbox detection...",
      rebuildRowIndex: "Rebuild Google row index",
      rebuildRowIndexNow: "Rebuild Google row index now",
      rebuildingRowIndex: "Rebuilding Google row index...",
      clearLocalAppState: "Clear local app state",
      clearLocalAppStateConfirm:
        "Clear local app state for this app? Google OAuth connection will stay connected.",
      localAppStateCleared: "Local app state cleared. Re-import the Google Sheet.",
      googleRowIndexNotBuilt: "Google row index not built",
      xlsxEventIndexNotBuilt: "XLSX event index not built",
      rowIndexFailed: "Failed to prepare Google row index",
      testWriteFirstPassedRow: "Test write first passed row",
      testWriteExactG69: "Test write exact G69 A1",
      testWriteExactG85: "Test write exact G85",
      missingSourceRowMapping: "Missing source row mapping",
      googleNotConnected: "Google not connected",
      connectGoogleFirst: "Connect Google first",
      authRequired: "Google auth required",
      authPending: "Complete Google sign-in in the browser.",
      sheetSyncFailed: "Sheet sync failed",
      networkRetry: "Network issue, will retry automatically",
      syncTimeoutRetry:
        `Google Sheets did not respond within ${googleSheetSyncRequestTimeoutSeconds} seconds, will retry automatically`,
      nextRetryIn: (seconds: number) => `Next retry in ${seconds} sec`,
      googleRowMappingMissing: (count: number) =>
        `No matching Google Sheet row found for ${count} events`,
      skippedEventsWithoutCheckboxRow: (count: number) =>
        `Skipped events without checkbox row: ${count}`,
      noCheckboxRowsForPendingEvents:
        "No checkbox rows found for pending events",
      importSheetFirst: "Import Google Sheet first",
      checkboxColumnNotFound: "Checkbox column not found",
      noPendingUpdates: "No pending updates",
      syncInProgress: "Sync already running",
    },
    modeImport: {
      android: {
        sheetUrlHint:
          "Open the Analytics_GooglePlay tab and copy its full URL.",
        sheetUrlHintPrefix: "Open the ",
        sheetUrlHintStrongText: "Analytics_GooglePlay",
        sheetUrlHintSuffix: " tab and copy its full URL.",
        sheetTabNamePlaceholder: "For example Analytics_GooglePlay",
        writeSyncTitle: "GOOGLE WRITE SYNC",
        loadedSpec: "LOADED SPEC",
        uploadSpec: "Upload Android spec",
      },
      ios: {
        sheetUrlHint:
          "Open the Analytics_iOS tab and paste its full URL.",
        sheetTabNamePlaceholder: "For example Analytics_iOS",
        writeSyncTitle: "iOS GOOGLE WRITE SYNC",
        loadedSpec: "LOADED iOS SPEC",
        uploadSpec: "Upload iOS spec",
      },
      unity: {
        sheetUrlHint: "",
        sheetTabNamePlaceholder: "For example Unity or Analytics_Unity",
        writeSyncTitle: "UNITY GOOGLE WRITE SYNC",
        loadedSpec: "LOADED UNITY SPEC",
        uploadSpec: "Upload Unity spec",
      },
    },
    loadedSpec: "Loaded spec",
    fileUploadUnavailableForGoogleSheet:
      "File upload is available after detaching the Google Sheet",
    ready: "Ready",
    warnings: "Warnings",
    more: "more",
    filters: "Filters",
    eventTypeFilter: "Event type",
    statusFilter: "Status",
    filterLabels: {
      all: "All",
      passed: "Passed",
      duplicate: "Duplicate",
      unknown: "Unknown",
      not_checked: "Not checked",
    },
    unityEventGroupLabels: {
      all: "All",
      appmetrica: "AppMetrica",
      appsflyer: "AppsFlyer",
      ab_test: "A/B test",
    },
    statuses: {
      passed: "Passed",
      partial: "Partial",
      duplicate: "Duplicate",
      unknown: "Unknown",
      notChecked: "Not checked",
      live: "Live",
      connecting: "Connecting",
      error: "Error",
      disconnected: "Disconnected",
    },
    stats: {
      passed: "Passed",
      duplicate: "Duplicate",
      unknown: "Unknown",
      partial: "Partial",
      notChecked: "Not checked",
    },
    table: {
      events: "Events",
      imported: "Imported",
      status: "Status",
      event: "Event",
      value: "Value",
      description: "Description",
      noSpecLoaded:
        "No spec loaded. Upload a spec file to start analytics validation.",
      noRowsParsed: "No rows parsed",
      noRowsParsedHint:
        "The file was read, but no meaningful rows were found. Try another sheet or check that cells are not all empty.",
    },
    coverage: {
      specCoverage: "Spec coverage",
      coveredRows: "Covered rows",
      coverage: "Coverage",
      passedRows: "Passed rows",
      partial: "Partial",
      notChecked: "Not checked",
    },
    buttons: {
      resetResults: "Reset results",
      exportJson: "Export JSON",
      exportCheckedXlsx: "Export checked XLSX",
      save: "Save",
      delete: "Delete",
      detectApp: "Detect app",
      detecting: "Detecting",
    },
    titles: {
      importSpecToReset: "Import a spec to reset results",
      clearCounters: "Clear counters and matched results",
      downloadCheckedXlsx: "Download XLSX copy with matched rows checked",
      importWorkbookForCheckedXlsx:
        "Import a workbook with a Check column to export checked XLSX",
      xlsxExportForUploadedFiles:
        "XLSX export is available for uploaded files",
      importSpecToExportJson: "Import a spec to export JSON",
      downloadJson: "Download QA session JSON",
    },
    recentResults: "Recent Results",
    selectedRowDetails: "Selected Row Details",
    noRowSelected: "No row selected",
    new: "New",
    noSpecLoaded:
      "No spec loaded. Upload a spec file to start analytics validation.",
    noEventsYet: {
      android: "No events yet. Connect Android or paste logs manually.",
      ios: "No events yet. Connect iOS or paste logs manually.",
      unity: "No events yet. Connect Unity or process an event manually.",
    },
    noAnalyticsLinesParsed:
      "No analytics lines parsed (empty input or no matching markers).",
    noNotCheckedEventResults:
      "Not checked is a row filter; there are no event-level results for it.",
    noAnalyticsLinesInFilter: (filter: string) =>
      `No ${filter.toLowerCase()} analytics lines in this filter.`,
    exportMessages: {
      importWorkbookFirst: "Import a workbook before exporting checked XLSX.",
      worksheetMetadataMissing:
        "Checked XLSX export failed: worksheet metadata is missing.",
      checkColumnMetadataMissing:
        "Checked XLSX export failed: Check column metadata is missing.",
      checkedXlsxFailed: "Checked XLSX export failed.",
      checkedXlsxFailedWithReason: (message: string) =>
        `Checked XLSX export failed: ${message}`,
    },
    android: {
      packageName: "Android package name",
      savedPackages: "Saved packages",
      liveTitle: "Android Live",
      clearLive: "Clear live",
      connect: "Connect Android",
      stop: "Stop",
      liveLog: "Live log (last 100)",
      noLiveLines: "No live lines yet. Connect while the game is running.",
      enterPackageFirst: "Enter Android package name first.",
      packageMismatch:
        "The uploaded spec does not match the current package name.",
      noDevice: "No Android device connected.",
      uploadSpecFirst: "Please upload a spec first.",
      connectFailed: "Android connect failed",
      liveDisconnected: "Live stream disconnected",
      detectFailed:
        "Could not detect foreground Android package. Make sure the app is open on device.",
    },
    ios: {
      bundleId: "iOS bundle id",
      liveTitle: "iOS Live",
      connect: "Connect iOS",
      liveLog: "iOS live log (last 100)",
      noLiveLines: "No iOS live lines yet. Connect while the game is running.",
      placeholder:
        "iOS live capture is a placeholder for now. Android package names are not used in this mode.",
      startFailed: "iOS start failed",
      connectFailed: "iOS connect failed",
      liveDisconnected: "Live stream disconnected",
      lunarConsoleTitle: "LunarConsole logs",
      lunarConsolePlaceholder: "Paste LunarConsole log lines...",
      lunarConsoleProcess: "Process logs",
      lunarConsoleUpload: "Upload LunarConsole log",
      lunarConsoleUploadHint: "Supports analytics_live.log from iOS dev build (AnalyticsLogBridge).",
      lunarConsoleRawPreview: "Raw preview (last 100)",
    },
    unity: {
      liveTitle: "Unity Live",
      connect: "Connect Unity",
      liveLog: "Unity live log (last 100)",
      noLiveLines:
        "No Unity live lines yet. Connect while Unity Editor is running.",
      connectedStatus: "Connected",
      connectedNoEvents:
        "Connected to Editor.log / Player.log. New analytics events will appear after actions in Unity.",
      showAllLogLines: "Show all Unity log lines",
      eventInputLabel: "Paste Unity event/log line",
      eventInputPlaceholder: "funnel.main.menu.play.click",
      processEvent: "Process event",
      logPath: "Unity Editor.log / Player.log path",
      logPathHint:
        "Unity live reads the selected Editor.log/Player.log file. If multiple Unity projects are open, choose the target game's log manually.",
      logTargetHint:
        "Target game is determined by the selected log file.",
      startFailed: "Unity start failed",
      connectFailed: "Unity connect failed",
      liveDisconnected: "Unity live stream disconnected",
      editorLogNotFound:
        "Unity Editor.log / Player.log was not found. Start Unity or provide the full path to Editor.log / Player.log.",
      editorLogFullPathRequired:
        "Please provide full path to Editor.log / Player.log",
      connectTimeout:
        "Unity connection timed out. Check Editor.log / Player.log path and try again.",
    },
    logPanel: {
      logs: "Logs",
      logsHint: "Paste console lines, then Process",
      logPlaceholder: "Paste debug console lines here...",
      clearLogs: "Clear logs",
      resetSession: "Reset session",
      process: "Process",
    },
  },
  ru: {
    mode: "Режим",
    settings: "Настройки",
    import: "Импорт",
    exportSectionTitle: "ЭКСПОРТ",
    detachSpec: "Открепить таблицу",
    detachSpecConfirm:
      "Есть несинхронизированные изменения. Открепить таблицу и очистить очередь?",
    importFailed: "Не удалось импортировать файл",
    uploadSpec: "Загрузить spec",
    fileImportFallback: "Или импорт из файла",
    reading: "Чтение...",
    googleSheetUrlPlaceholder: "URL Google Таблицы",
    googleSheetUrlHint:
      "Открой нужную вкладку в Google Таблице и вставь её полный URL.",
    importGoogleSheet: "Импортировать Google Таблицу",
    importingGoogleSheet: "Импорт...",
    googleConnected: "Запись в Google: подключена",
    googleNotConnected: "Запись в Google: не настроена",
    connectGoogle: "Подключить Google",
    connectingGoogle: "Подключение...",
    autoUpdateGoogleSheet: "Автообновление Google Таблицы",
    checkboxColumn: "Колонка чекбоксов",
    sheetTabName: "Имя вкладки",
    useColumn: "Сохранить колонку",
    readOnlyMode:
      "Read-only import works. Connect Google only if you want to write Passed results back to the sheet.",
    sheetSync: "Синхронизация",
    google: {
      sheetUrlPlaceholder: "URL Google Таблицы",
      sheetUrlHint:
        "Открой нужную вкладку в Google Таблице и вставь её полный URL.",
      sheetUrlRequired: "Вставь URL Google Таблицы.",
      invalidSheetUrl: "Некорректная ссылка на Google Таблицу.",
      invalidSheetUrlSheetIdNotFound:
        "Некорректная ссылка на Google Таблицу: не найден sheetId.",
      invalidSheetUrlGidNotFound:
        "Некорректная ссылка на Google Таблицу: не найден gid.",
      importSheet: "Импортировать Google Таблицу",
      importedSheet: "Импортировано",
      importingSheet: "Импортируем...",
      importSlowHint:
        "Таблица большая, импорт может занять 1–2 минуты или дольше...",
      importStillRunningHint: "Импорт всё ещё идёт. Не закрывай приложение.",
      cancelImport: "Отменить импорт",
      importCancelled: "Импорт отменён",
      importNetworkIssue:
        "Сеть нестабильна. Не удалось импортировать Google Таблицу, повторите попытку.",
      importNetworkRetry:
        "Сеть нестабильна, повторим импорт автоматически",
      importAccessDenied:
        "Не удалось импортировать Google Таблицу. Проверьте доступ к таблице.",
      useUploadedXlsxForGoogleSync:
        "Использовать XLSX для синхронизации с Google",
      uploadedXlsxGoogleSyncHint:
        "Если импорт Google Таблицы не проходит, скачай вкладку как .xlsx и загрузи файл ниже. Запись галочек всё равно пойдёт в Google Таблицу по URL.",
      uploadedXlsxGoogleSyncLoaded:
        "XLSX загружен, синхронизация с Google включена",
      xlsxSheetNotFound: (sheetName: string) =>
        `В XLSX не найдена вкладка ${sheetName}`,
      xlsxNoSpecRows: (sheetName: string) =>
        `Во вкладке ${sheetName} не найдены строки спеки`,
      importFailed:
        "Не удалось импортировать Google Таблицу. Проверь доступ к ней.",
      googleConnectionExpired:
        "Google подключение истекло. Подключи Google заново.",
      googleOAuthTimeout:
        "Google OAuth долго отвечает. Попробуй переподключить Google.",
      googleOAuthMisconfigured:
        "Google OAuth настроен неверно. Проверь GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET.",
      googleSheetAccessDenied: "Нет доступа к Google Таблице.",
      googleSheetNotFound: "Google Таблица или вкладка не найдена.",
      specLoaded: "Spec загружен",
      preparingSync: "Готовим синхронизацию...",
      syncReady: "Синхронизация готова",
      writeSyncTitle: "ЗАПИСЬ В GOOGLE",
      connected: "Подключено",
      notConnected: "Не подключено",
      connect: "Подключить Google",
      reconnect: "Переподключить Google",
      disconnect: "Отключить",
      connecting: "Подключение...",
      autoUpdate: "Автообновление",
      importFirst: "Сначала импортируй Google Таблицу",
      sheetTabName: "Имя вкладки",
      sheetTabDetectedAutomatically: "Вкладка определена автоматически",
      checkboxColumn: "Колонка чекбоксов",
      overrideCheckboxColumn: "Переопределить колонку чекбоксов",
      save: "Сохранить",
      sheetSync: "Синхронизация",
      sheetSyncStatus: {
        idle: "ожидание",
        pending: "ожидает",
        syncing: "отправляем...",
        synced: "выполнена",
        failed: "ошибка",
      },
      sheetSyncPending: (count: number) => `ожидает ${count}`,
      lastSyncRows: (count: number) =>
        `Последняя синхронизация: ${count} строк`,
      debugDetails: "Детали отладки",
      noDebugDetails: "Деталей отладки пока нет.",
      checkboxColumnSaved: (column: string) =>
        `Колонка чекбоксов сохранена: ${column}`,
      sheetTabSaved: (title: string) => `Вкладка сохранена: ${title}`,
      invalidColumnLetter: "Некорректная буква колонки.",
      sheetTabNameRequired: "Укажи имя вкладки",
      checkboxColumnNotFoundManual:
        "Колонка чекбоксов не найдена. Укажи её вручную.",
      syncPendingNow: "Синхронизировать ожидающие",
      previewWriteTargets: "Предпросмотр целей записи",
      previewNoWrites:
        "Предпросмотр целей записи: записи в Google не было.",
      retryCheckboxDetection: "Повторить поиск колонки чекбоксов",
      retryingCheckboxDetection: "Повторный поиск...",
      rebuildRowIndex: "Пересобрать индекс строк",
      rebuildRowIndexNow: "Пересобрать индекс строк сейчас",
      rebuildingRowIndex: "Индекс строк пересобирается...",
      clearLocalAppState: "Очистить локальное состояние",
      clearLocalAppStateConfirm:
        "Очистить локальное состояние приложения? Подключение Google OAuth останется.",
      localAppStateCleared:
        "Локальное состояние очищено. Импортируй Google Таблицу заново.",
      googleRowIndexNotBuilt: "Индекс строк Google не построен",
      xlsxEventIndexNotBuilt: "Индекс событий XLSX не построен",
      rowIndexFailed: "Не удалось подготовить индекс строк Google",
      testWriteFirstPassedRow:
        "Тест: записать первую пройденную строку",
      testWriteExactG69: "Тест: записать G69",
      testWriteExactG85: "Тест: записать G85",
      missingSourceRowMapping: "Не найдена привязка строк",
      googleNotConnected: "Google не подключён",
      connectGoogleFirst: "Сначала подключи Google",
      authRequired: "Нужна авторизация Google",
      authPending: "Заверши вход в Google в браузере.",
      sheetSyncFailed: "Синхронизация не удалась",
      networkRetry: "Сеть нестабильна, повторим автоматически",
      syncTimeoutRetry:
        `Google Sheets не ответил за ${googleSheetSyncRequestTimeoutSeconds} секунд, повторим автоматически`,
      nextRetryIn: (seconds: number) =>
        `Следующая попытка через ${seconds} сек`,
      googleRowMappingMissing: (count: number) =>
        `Не найдено соответствие строке Google Sheet для ${count} событий`,
      skippedEventsWithoutCheckboxRow: (count: number) =>
        `Пропущено событий без строки чекбокса: ${count}`,
      noCheckboxRowsForPendingEvents:
        "Нет строк чекбоксов для ожидающих событий",
      importSheetFirst: "Сначала импортируй Google Таблицу",
      checkboxColumnNotFound: "Колонка чекбоксов не найдена",
      noPendingUpdates: "Нет ожидающих изменений",
      syncInProgress: "Синхронизация уже выполняется",
    },
    modeImport: {
      android: {
        sheetUrlHint:
          "Открой вкладку Analytics_GooglePlay и скопируй полный URL.",
        sheetUrlHintPrefix: "Открой вкладку ",
        sheetUrlHintStrongText: "Analytics_GooglePlay",
        sheetUrlHintSuffix: " и скопируй полный URL.",
        sheetTabNamePlaceholder: "Например Analytics_GooglePlay",
        writeSyncTitle: "ЗАПИСЬ В GOOGLE",
        loadedSpec: "ЗАГРУЖЕННЫЙ SPEC",
        uploadSpec: "Загрузить Android spec",
      },
      ios: {
        sheetUrlHint:
          "Открой вкладку Analytics_iOS и вставь её полный URL.",
        sheetTabNamePlaceholder: "Например Analytics_iOS",
        writeSyncTitle: "ЗАПИСЬ iOS В GOOGLE",
        loadedSpec: "ЗАГРУЖЕННЫЙ iOS SPEC",
        uploadSpec: "Загрузить iOS spec",
      },
      unity: {
        sheetUrlHint: "",
        sheetTabNamePlaceholder: "Например Unity или Analytics_Unity",
        writeSyncTitle: "ЗАПИСЬ UNITY В GOOGLE",
        loadedSpec: "ЗАГРУЖЕННЫЙ UNITY SPEC",
        uploadSpec: "Загрузить Unity spec",
      },
    },
    loadedSpec: "Загруженный spec",
    fileUploadUnavailableForGoogleSheet:
      "Загрузка файла доступна после открепления Google Таблицы",
    ready: "Готово",
    warnings: "Предупреждения",
    more: "ещё",
    filters: "Фильтры",
    eventTypeFilter: "Тип события",
    statusFilter: "Статус",
    filterLabels: {
      all: "Все",
      passed: "Пройдено",
      duplicate: "Дубликат",
      unknown: "Неизвестно",
      not_checked: "Не проверено",
    },
    unityEventGroupLabels: {
      all: "Все",
      appmetrica: "AppMetrica",
      appsflyer: "AppsFlyer",
      ab_test: "A/B test",
    },
    statuses: {
      passed: "Пройдено",
      partial: "Частично",
      duplicate: "Дубликат",
      unknown: "Неизвестно",
      notChecked: "Не проверено",
      live: "Live",
      connecting: "Подключение",
      error: "Ошибка",
      disconnected: "Отключено",
    },
    stats: {
      passed: "Пройдено",
      duplicate: "Дубликат",
      unknown: "Неизвестно",
      partial: "Частично",
      notChecked: "Не проверено",
    },
    table: {
      events: "События",
      imported: "Импортировано",
      status: "Статус",
      event: "Событие",
      value: "Значение",
      description: "Описание",
      noSpecLoaded:
        "Спецификация не загружена. Загрузите файл spec, чтобы начать проверку аналитики.",
      noRowsParsed: "Строки не найдены",
      noRowsParsedHint:
        "Файл прочитан, но значимые строки не найдены. Попробуйте другой лист или проверьте, что ячейки не пустые.",
    },
    coverage: {
      specCoverage: "Покрытие spec",
      coveredRows: "Покрытые строки",
      coverage: "Покрытие",
      passedRows: "Пройденные строки",
      partial: "Частично",
      notChecked: "Не проверено",
    },
    buttons: {
      resetResults: "Сбросить результаты",
      exportJson: "Экспорт JSON",
      exportCheckedXlsx: "Экспорт XLSX с отметками",
      save: "Сохранить",
      delete: "Удалить",
      detectApp: "Определить app",
      detecting: "Определение",
    },
    titles: {
      importSpecToReset: "Загрузите spec, чтобы сбросить результаты",
      clearCounters: "Очистить счётчики и найденные результаты",
      downloadCheckedXlsx: "Скачать XLSX-копию с отмеченными строками",
      importWorkbookForCheckedXlsx:
        "Загрузите workbook с колонкой Check для экспорта XLSX с отметками",
      xlsxExportForUploadedFiles:
        "Экспорт XLSX доступен для загруженного файла",
      importSpecToExportJson: "Загрузите spec для экспорта JSON",
      downloadJson: "Скачать JSON QA-сессии",
    },
    recentResults: "Последние события",
    selectedRowDetails: "Детали выбранной строки",
    noRowSelected: "Строка не выбрана",
    new: "Новое",
    noSpecLoaded:
      "Спецификация не загружена. Загрузите файл spec, чтобы начать проверку аналитики.",
    noEventsYet: {
      android: "Событий пока нет. Подключите Android или вставьте логи вручную.",
      ios: "Событий пока нет. Подключите iOS или вставьте логи вручную.",
      unity: "Событий пока нет. Подключите Unity или обработайте event вручную.",
    },
    noAnalyticsLinesParsed:
      "Строки аналитики не распознаны: ввод пустой или маркеры не найдены.",
    noNotCheckedEventResults:
      "Не проверено — это фильтр строк; на уровне событий для него нет результатов.",
    noAnalyticsLinesInFilter: (filter: string) =>
      `В этом фильтре нет строк аналитики: ${filter}.`,
    exportMessages: {
      importWorkbookFirst:
        "Сначала загрузите workbook для экспорта XLSX с отметками.",
      worksheetMetadataMissing:
        "Не удалось экспортировать XLSX: отсутствуют метаданные листа.",
      checkColumnMetadataMissing:
        "Не удалось экспортировать XLSX: отсутствуют метаданные колонки Check.",
      checkedXlsxFailed: "Не удалось экспортировать XLSX с отметками.",
      checkedXlsxFailedWithReason: (message: string) =>
        `Не удалось экспортировать XLSX: ${message}`,
    },
    android: {
      packageName: "Android package name",
      savedPackages: "Сохранённые packages",
      liveTitle: "Android лог",
      clearLive: "Очистить live",
      connect: "Подключить Android",
      stop: "Остановить",
      liveLog: "Live-лог (последние 100)",
      noLiveLines: "Live-строк пока нет. Подключитесь, пока игра запущена.",
      enterPackageFirst: "Сначала введите Android package name.",
      packageMismatch:
        "Загруженный spec не соответствует текущему package name.",
      noDevice: "Android-устройство не подключено.",
      uploadSpecFirst: "Сначала загрузите spec.",
      connectFailed: "Не удалось подключить Android",
      liveDisconnected: "Live-поток отключился",
      detectFailed:
        "Не удалось определить foreground Android package. Убедитесь, что приложение открыто на устройстве.",
    },
    ios: {
      bundleId: "iOS bundle id",
      liveTitle: "iOS лог",
      connect: "Подключить iOS",
      liveLog: "iOS live-лог (последние 100)",
      noLiveLines: "iOS live-строк пока нет. Подключитесь, пока игра запущена.",
      placeholder:
        "iOS live capture пока подготовлен как заглушка. Android package names в этом режиме не используются.",
      startFailed: "Не удалось запустить iOS",
      connectFailed: "Не удалось подключить iOS",
      liveDisconnected: "Live-поток отключился",
      lunarConsoleTitle: "LunarConsole logs",
      lunarConsolePlaceholder: "Вставьте строки из LunarConsole...",
      lunarConsoleProcess: "Обработать логи",
      lunarConsoleUpload: "Загрузить LunarConsole log",
      lunarConsoleUploadHint:
        "Поддерживается analytics_live.log из iOS dev build (AnalyticsLogBridge).",
      lunarConsoleRawPreview: "Raw preview (последние 100)",
    },
    unity: {
      liveTitle: "Unity лог",
      connect: "Подключить Unity",
      liveLog: "Unity live-лог (последние 100)",
      noLiveLines:
        "Unity live-строк пока нет. Подключитесь, пока Unity Editor запущен.",
      connectedStatus: "Подключено",
      connectedNoEvents:
        "Подключено к Editor.log / Player.log. Новые analytics-события появятся после действий в Unity.",
      showAllLogLines: "Показывать все строки Unity log",
      eventInputLabel: "Вставьте Unity event/log line",
      eventInputPlaceholder: "funnel.main.menu.play.click",
      processEvent: "Обработать event",
      logPath: "Путь к Unity Editor.log / Player.log",
      logPathHint:
        "Unity live читает выбранный Editor.log/Player.log файл. Если открыто несколько Unity-проектов, укажите лог нужной игры вручную.",
      logTargetHint:
        "Игра определяется выбранным log-файлом",
      startFailed: "Не удалось запустить Unity",
      connectFailed: "Не удалось подключить Unity",
      liveDisconnected: "Unity live-поток отключился",
      editorLogNotFound:
        "Unity Editor.log / Player.log не найден. Запустите Unity или укажите полный путь до Editor.log / Player.log.",
      editorLogFullPathRequired:
        "Укажите полный путь до Editor.log / Player.log",
      connectTimeout:
        "Подключение Unity превысило лимит времени. Проверьте путь к Editor.log / Player.log и повторите.",
    },
    logPanel: {
      logs: "Логи",
      logsHint: "Вставьте строки логов и нажмите «Обработать»",
      logPlaceholder: "Вставьте строки debug console здесь...",
      clearLogs: "Очистить логи",
      resetSession: "Сбросить сессию",
      process: "Обработать",
    },
  },
} satisfies Record<UiLanguage, {
  mode: string;
  settings: string;
  import: string;
  exportSectionTitle: string;
  detachSpec: string;
  detachSpecConfirm: string;
  importFailed: string;
  uploadSpec: string;
  fileImportFallback: string;
  reading: string;
  googleSheetUrlPlaceholder: string;
  googleSheetUrlHint: string;
  importGoogleSheet: string;
  importingGoogleSheet: string;
  googleConnected: string;
  googleNotConnected: string;
  connectGoogle: string;
  connectingGoogle: string;
  autoUpdateGoogleSheet: string;
  checkboxColumn: string;
  sheetTabName: string;
  useColumn: string;
  readOnlyMode: string;
  sheetSync: string;
  google: {
    sheetUrlPlaceholder: string;
    sheetUrlHint: string;
    sheetUrlRequired: string;
    invalidSheetUrl: string;
    invalidSheetUrlSheetIdNotFound: string;
    invalidSheetUrlGidNotFound: string;
    importSheet: string;
    importedSheet: string;
    importingSheet: string;
    importSlowHint: string;
    importStillRunningHint: string;
    cancelImport: string;
    importCancelled: string;
    importNetworkIssue: string;
    importNetworkRetry: string;
    importAccessDenied: string;
    useUploadedXlsxForGoogleSync: string;
    uploadedXlsxGoogleSyncHint: string;
    uploadedXlsxGoogleSyncLoaded: string;
    xlsxSheetNotFound: (sheetName: string) => string;
    xlsxNoSpecRows: (sheetName: string) => string;
    importFailed: string;
    googleConnectionExpired: string;
    googleOAuthTimeout: string;
    googleOAuthMisconfigured: string;
    googleSheetAccessDenied: string;
    googleSheetNotFound: string;
    specLoaded: string;
    preparingSync: string;
    syncReady: string;
    writeSyncTitle: string;
    connected: string;
    notConnected: string;
    connect: string;
    reconnect: string;
    disconnect: string;
    connecting: string;
    autoUpdate: string;
    importFirst: string;
    sheetTabName: string;
    sheetTabDetectedAutomatically: string;
    checkboxColumn: string;
    overrideCheckboxColumn: string;
    save: string;
    sheetSync: string;
    sheetSyncStatus: Record<SidebarSheetSyncStatus, string>;
    sheetSyncPending: (count: number) => string;
    lastSyncRows: (count: number) => string;
    debugDetails: string;
    noDebugDetails: string;
    checkboxColumnSaved: (column: string) => string;
    sheetTabSaved: (title: string) => string;
    invalidColumnLetter: string;
    sheetTabNameRequired: string;
    checkboxColumnNotFoundManual: string;
    syncPendingNow: string;
    previewWriteTargets: string;
    previewNoWrites: string;
    retryCheckboxDetection: string;
    retryingCheckboxDetection: string;
    rebuildRowIndex: string;
    rebuildRowIndexNow: string;
    rebuildingRowIndex: string;
    clearLocalAppState: string;
    clearLocalAppStateConfirm: string;
    localAppStateCleared: string;
    googleRowIndexNotBuilt: string;
    xlsxEventIndexNotBuilt: string;
    rowIndexFailed: string;
    testWriteFirstPassedRow: string;
    testWriteExactG69: string;
    testWriteExactG85: string;
    missingSourceRowMapping: string;
    googleNotConnected: string;
    connectGoogleFirst: string;
    authRequired: string;
    authPending: string;
    sheetSyncFailed: string;
    networkRetry: string;
    syncTimeoutRetry: string;
    nextRetryIn: (seconds: number) => string;
    googleRowMappingMissing: (count: number) => string;
    skippedEventsWithoutCheckboxRow: (count: number) => string;
    noCheckboxRowsForPendingEvents: string;
    importSheetFirst: string;
    checkboxColumnNotFound: string;
    noPendingUpdates: string;
    syncInProgress: string;
  };
  modeImport: Record<
    PlatformMode,
    {
      sheetUrlHint: string;
      sheetUrlHintPrefix?: string;
      sheetUrlHintStrongText?: string;
      sheetUrlHintSuffix?: string;
      sheetTabNamePlaceholder: string;
      writeSyncTitle: string;
      loadedSpec: string;
      uploadSpec: string;
    }
  >;
  loadedSpec: string;
  fileUploadUnavailableForGoogleSheet: string;
  ready: string;
  warnings: string;
  more: string;
  filters: string;
  eventTypeFilter: string;
  statusFilter: string;
  filterLabels: Record<SidebarFilter, string>;
  unityEventGroupLabels: Record<UnityEventGroupTabId, string>;
  statuses: {
    passed: string;
    partial: string;
    duplicate: string;
    unknown: string;
    notChecked: string;
    live: string;
    connecting: string;
    error: string;
    disconnected: string;
  };
  stats: {
    passed: string;
    duplicate: string;
    unknown: string;
    partial: string;
    notChecked: string;
  };
  table: {
    events: string;
    imported: string;
    status: string;
    event: string;
    value: string;
    description: string;
    noSpecLoaded: string;
    noRowsParsed: string;
    noRowsParsedHint: string;
  };
  coverage: {
    specCoverage: string;
    coveredRows: string;
    coverage: string;
    passedRows: string;
    partial: string;
    notChecked: string;
  };
  buttons: {
    resetResults: string;
    exportJson: string;
    exportCheckedXlsx: string;
    save: string;
    delete: string;
    detectApp: string;
    detecting: string;
  };
  titles: {
    importSpecToReset: string;
    clearCounters: string;
    downloadCheckedXlsx: string;
    importWorkbookForCheckedXlsx: string;
    xlsxExportForUploadedFiles: string;
    importSpecToExportJson: string;
    downloadJson: string;
  };
  recentResults: string;
  selectedRowDetails: string;
  noRowSelected: string;
  new: string;
  noSpecLoaded: string;
  noEventsYet: Record<PlatformMode, string>;
  noAnalyticsLinesParsed: string;
  noNotCheckedEventResults: string;
  noAnalyticsLinesInFilter: (filter: string) => string;
  exportMessages: {
    importWorkbookFirst: string;
    worksheetMetadataMissing: string;
    checkColumnMetadataMissing: string;
    checkedXlsxFailed: string;
    checkedXlsxFailedWithReason: (message: string) => string;
  };
  android: {
    packageName: string;
    savedPackages: string;
    liveTitle: string;
    clearLive: string;
    connect: string;
    stop: string;
    liveLog: string;
    noLiveLines: string;
    enterPackageFirst: string;
    packageMismatch: string;
    noDevice: string;
    uploadSpecFirst: string;
    connectFailed: string;
    liveDisconnected: string;
    detectFailed: string;
  };
  ios: {
    bundleId: string;
    liveTitle: string;
    connect: string;
    liveLog: string;
    noLiveLines: string;
    placeholder: string;
    startFailed: string;
    connectFailed: string;
    liveDisconnected: string;
    lunarConsoleTitle: string;
    lunarConsolePlaceholder: string;
    lunarConsoleProcess: string;
    lunarConsoleUpload: string;
    lunarConsoleUploadHint: string;
    lunarConsoleRawPreview: string;
  };
  unity: {
    liveTitle: string;
    connect: string;
    liveLog: string;
    noLiveLines: string;
    connectedStatus: string;
    connectedNoEvents: string;
    showAllLogLines: string;
    eventInputLabel: string;
    eventInputPlaceholder: string;
    processEvent: string;
    logPath: string;
    logPathHint: string;
    logTargetHint: string;
    startFailed: string;
    connectFailed: string;
    liveDisconnected: string;
    editorLogNotFound: string;
    editorLogFullPathRequired: string;
    connectTimeout: string;
  };
  logPanel: {
    logs: string;
    logsHint: string;
    logPlaceholder: string;
    clearLogs: string;
    resetSession: string;
    process: string;
  };
}>;

type UiLabels = (typeof uiLabels)[UiLanguage];

function localizeUnityLiveError(
  errorCode: string | null | undefined,
  message: string | null | undefined,
  labels: UiLabels["unity"],
): string {
  if (errorCode === "UNITY_EDITOR_LOG_NOT_FOUND") {
    return labels.editorLogNotFound;
  }
  if (errorCode === "UNITY_EDITOR_LOG_PATH_IS_DIRECTORY") {
    return labels.editorLogFullPathRequired;
  }
  return message?.trim() || labels.connectFailed;
}

function localizeGoogleSheetUrlError(
  value: string,
  labels: UiLabels["google"],
): string {
  const message = value.trim();
  if (/Invalid Google Sheet URL:\s*sheetId not found\.?/i.test(message)) {
    return labels.invalidSheetUrlSheetIdNotFound;
  }
  if (
    /Invalid Google Sheet URL:\s*gid not found\.?/i.test(message) ||
    /Could not determine sheet tab\./i.test(message)
  ) {
    return labels.invalidSheetUrlGidNotFound;
  }
  if (/Invalid Google Sheet URL\.?/i.test(message)) {
    return labels.invalidSheetUrl;
  }
  if (/Google connection expired\. Connect Google again\.?/i.test(message)) {
    return labels.googleConnectionExpired;
  }
  if (
    /Google OAuth is taking too long to respond\. Try reconnecting Google\.?/i.test(
      message,
    )
  ) {
    return labels.googleOAuthTimeout;
  }
  if (
    /Google OAuth is misconfigured\. Check GOOGLE_OAUTH_CLIENT_ID \/ GOOGLE_OAUTH_CLIENT_SECRET\.?/i.test(
      message,
    )
  ) {
    return labels.googleOAuthMisconfigured;
  }
  if (/No access to Google Sheet\.?/i.test(message)) {
    return labels.googleSheetAccessDenied;
  }
  if (/Google Sheet or tab not found\.?/i.test(message)) {
    return labels.googleSheetNotFound;
  }
  return value;
}

function classifyGoogleSheetImportClientError(options: {
  message: string;
  status?: number | null;
  technicalDetail?: string | null;
  networkIssue?: boolean;
  importErrorType?: GoogleSheetImportErrorType;
}): GoogleSheetImportErrorType {
  if (options.importErrorType) {
    return options.importErrorType;
  }

  const detail = [options.message, options.technicalDetail]
    .filter(Boolean)
    .join(" ");
  if (
    /Invalid Google Sheet URL|Could not determine sheet tab|sheetId not found|gid not found/i.test(
      detail,
    )
  ) {
    return "invalid-url";
  }
  if (
    options.networkIssue ||
    options.status === 503 ||
    isGoogleSheetNetworkIssueMessage(detail)
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

function localizeGoogleSheetImportError(
  message: string,
  labels: UiLabels["google"],
  importErrorType: GoogleSheetImportErrorType,
): string {
  if (importErrorType === "network") {
    return labels.importNetworkIssue;
  }
  if (importErrorType === "access") {
    return labels.importAccessDenied;
  }
  if (importErrorType === "invalid-url") {
    return localizeGoogleSheetUrlError(message, labels);
  }
  return localizeGoogleSheetUrlError(message, labels);
}

type GoogleSheetImportClientError = Error & {
  importErrorType?: GoogleSheetImportErrorType;
  networkIssue?: boolean;
  status?: number;
  technicalDetail?: string | null;
};

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function parseGoogleSheetUrlForWriteback(
  rawUrl: string,
): { spreadsheetId: string; gid: string } | null {
  const value = rawUrl.trim();
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    if (url.hostname !== "docs.google.com") {
      return null;
    }
    const spreadsheetId =
      url.pathname.match(/\/spreadsheets\/(?:u\/\d+\/)?d\/([^/?#]+)/)?.[1] ??
      null;
    const queryGid = url.searchParams.get("gid")?.trim();
    const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
    const hashGid = hashParams.get("gid")?.trim();
    const rawHashGid = url.hash.match(/[#&?]gid=([^&]+)/)?.[1] ?? null;
    const gid = queryGid || hashGid || rawHashGid || "";
    if (!spreadsheetId) {
      return null;
    }
    return { spreadsheetId, gid };
  } catch {
    return null;
  }
}

function isExcelWorkbookFile(file: File): boolean {
  const name = file.name.trim().toLowerCase();
  return name.endsWith(".xlsx") || name.endsWith(".xls");
}

function isGoogleSheetBooleanText(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "true" ||
    normalized === "false" ||
    normalized === "\u0438\u0441\u0442\u0438\u043d\u0430" ||
    normalized === "\u043b\u043e\u0436\u044c" ||
    normalized === "истина" ||
    normalized === "ложь"
  );
}

function buildFixedGoogleSheetCheckboxMatrixForLocalXlsx(
  matrix: string[][],
  checkboxMatrix: boolean[][],
): boolean[][] {
  return matrix.map((row, rowIndex) => {
    const width = Math.max(row.length, fixedGoogleSheetCheckboxColumnIndex + 1);
    const next = checkboxMatrix[rowIndex]?.slice(0, width) ?? [];
    while (next.length < width) {
      next.push(false);
    }
    const gValue = row[fixedGoogleSheetCheckboxColumnIndex]?.trim() ?? "";
    next[fixedGoogleSheetCheckboxColumnIndex] =
      next[fixedGoogleSheetCheckboxColumnIndex] ||
      isGoogleSheetBooleanText(gValue);
    return next;
  });
}

function isUsableSheetColumnIndex(value: number | null): boolean {
  return value !== null && Number.isInteger(value) && value >= 0;
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

function a1ColumnToIndex(value: string): number | null {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(normalized)) {
    return null;
  }
  let index = 0;
  for (const char of normalized) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index - 1;
}

function formatCheckboxDetectionError(
  value: string | null | undefined,
): string | null {
  const message = value?.trim();
  if (!message) {
    return null;
  }
  if (/^Checkbox detection failed:/i.test(message)) {
    return message;
  }
  if (
    /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ABORT_ERR|fetch failed|network/i.test(
      message,
    )
  ) {
    const detail = message.replace(/^fetch failed:\s*/i, "").trim();
    return `Checkbox detection failed: ${detail}. Re-import or retry.`;
  }
  return message;
}

function isGoogleSheetNetworkIssueMessage(
  value: string | null | undefined,
): boolean {
  return /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ABORT_ERR|AbortError|aborted|timeout|timed out|fetch failed|network|\b503\b/i.test(
    value ?? "",
  );
}

function isGoogleSheetTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.name === "AbortError" ||
    /AbortError|aborted|timeout|timed out/i.test(error.message)
  );
}

function getGoogleSheetSyncRetryDelayMs(attemptIndex: number): number {
  return (
    googleSheetSyncRetryDelayMs[
      Math.min(attemptIndex, googleSheetSyncRetryDelayMs.length - 1)
    ] ?? googleSheetSyncRetryDelayMs[googleSheetSyncRetryDelayMs.length - 1]
  );
}

function compactDebugValue(value: unknown, maxLength = 700): string {
  const text =
    typeof value === "string"
      ? value
      : value === undefined
        ? ""
        : JSON.stringify(value);
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

function compactDebugList(value: unknown, maxItems = 5): string[] {
  const items = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return items
    .map((item) =>
      typeof item === "string" ? item : compactDebugValue(item, 160),
    )
    .filter((item) => item.trim().length > 0)
    .slice(-maxItems);
}

function formatGoogleSheetNetworkAttempts(
  attempts: GoogleSheetNetworkAttemptDebug[] | undefined,
): string[] {
  if (!attempts || attempts.length === 0) {
    return [];
  }
  return attempts.map(
    (attempt) =>
      `attempt=${attempt.attempt}/${attempt.maxAttempts} transport=${attempt.transport} error.name=${attempt.errorName ?? "null"} error.message=${attempt.errorMessage ?? "null"} error.cause?.code=${attempt.causeCode ?? "null"} error.cause?.message=${attempt.causeMessage ?? "null"} technicalDetail=${attempt.technicalDetail}`,
  );
}

function formatGoogleSheetTestWriteDebug(options: {
  writeMode?: string;
  hasPassedRows?: boolean;
  selectedRowId?: string | null;
  eventName?: string | null;
  rowNumber: number | null;
  firstMappedRowNumber?: number | null;
  spreadsheetId?: string | null;
  gid?: string | null;
  sheetTitle?: string | null;
  manualSheetTitle?: string | null;
  checkboxColumnIndex?: number | null;
  columnLetter: string;
  gridRange: unknown;
  range?: string | null;
  endpoint?: string;
  requestBody?: unknown;
  apiStatus?: number | null;
  apiResponse?: string;
  technicalDetail?: string | null;
  errorName?: string | null;
  errorMessage?: string | null;
  causeCode?: string | null;
  causeMessage?: string | null;
  attemptCount?: number | null;
  attempts?: GoogleSheetNetworkAttemptDebug[];
  totalUpdatedCells?: number | null;
  totalUpdatedRows?: number | null;
  warning?: string | null;
}): string {
  return [
    options.writeMode ? `writeMode=${options.writeMode}` : null,
    options.hasPassedRows === undefined
      ? null
      : `hasPassedRows=${options.hasPassedRows}`,
    options.selectedRowId === undefined
      ? null
      : `selectedRowId=${options.selectedRowId ?? "null"}`,
    options.eventName === undefined
      ? null
      : `eventName=${options.eventName ?? ""}`,
    options.firstMappedRowNumber === undefined
      ? null
      : `firstMappedRowNumber=${options.firstMappedRowNumber ?? "null"}`,
    `sourceRowNumber=${options.rowNumber ?? "null"}`,
    options.spreadsheetId === undefined
      ? null
      : `spreadsheetId=${options.spreadsheetId ?? "null"}`,
    options.gid === undefined ? null : `gid=${options.gid ?? "null"}`,
    options.sheetTitle === undefined
      ? null
      : `sheetTitle=${options.sheetTitle ?? "null"}`,
    options.manualSheetTitle === undefined
      ? null
      : `manualSheetTitle=${options.manualSheetTitle ?? "null"}`,
    options.checkboxColumnIndex === undefined
      ? null
      : `checkboxColumnIndex=${options.checkboxColumnIndex ?? "null"}`,
    `checkboxColumnLetter=${options.columnLetter}`,
    `rowNumber=${options.rowNumber ?? "null"}`,
    `column=${options.columnLetter}`,
    options.range === undefined ? null : `range=${options.range ?? "null"}`,
    `gridRange=${compactDebugValue(options.gridRange, 260)}`,
    options.endpoint ? `endpoint=${options.endpoint}` : null,
    options.requestBody
      ? `requestBody=${compactDebugValue(options.requestBody, 500)}`
      : null,
    `apiStatus=${options.apiStatus ?? "null"}`,
    options.technicalDetail === undefined
      ? null
      : `technicalDetail=${options.technicalDetail ?? "null"}`,
    options.errorName === undefined
      ? null
      : `error.name=${options.errorName ?? "null"}`,
    options.errorMessage === undefined
      ? null
      : `error.message=${options.errorMessage ?? "null"}`,
    options.causeCode === undefined
      ? null
      : `error.cause?.code=${options.causeCode ?? "null"}`,
    options.causeMessage === undefined
      ? null
      : `error.cause?.message=${options.causeMessage ?? "null"}`,
    options.attemptCount === undefined
      ? null
      : `attemptCount=${options.attemptCount ?? "null"}`,
    ...formatGoogleSheetNetworkAttempts(options.attempts),
    `totalUpdatedCells=${options.totalUpdatedCells ?? "null"}`,
    `totalUpdatedRows=${options.totalUpdatedRows ?? "null"}`,
    `apiResponse=${compactDebugValue(options.apiResponse ?? "", 500)}`,
    options.warning ? `warning=${options.warning}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function getManualGoogleSheetCheckboxColumnIndex(
  meta: GoogleSheetSyncMetadata | null,
  manualColumnInput?: string,
): number | null {
  const manualInputIndex =
    manualColumnInput?.trim() ? a1ColumnToIndex(manualColumnInput) : null;
  if (manualInputIndex !== null) {
    if (
      meta?.checkboxColumnSource === "manual" ||
      manualInputIndex !== fixedGoogleSheetCheckboxColumnIndex
    ) {
      return manualInputIndex;
    }
    return null;
  }
  if (!meta) {
    return null;
  }
  if (
    meta.checkboxColumnSource === "manual" &&
    isUsableSheetColumnIndex(meta.checkboxColumnIndex ?? null)
  ) {
    return meta.checkboxColumnIndex as number;
  }
  if (meta.checkboxColumnSource === "manual") {
    const manualCandidate = meta.checkboxCandidates?.find(
      (candidate) =>
        candidate.header === "Manual" &&
        isUsableSheetColumnIndex(candidate.columnIndex),
    );
    if (manualCandidate) {
      return manualCandidate.columnIndex;
    }
  }
  return null;
}

function getGoogleSheetTabKey(
  value:
    | GoogleSheetSyncMetadata
    | { spreadsheetId?: string | null; gid?: string | null }
    | null,
): string | null {
  const spreadsheetId = value?.spreadsheetId?.trim() ?? "";
  const gid = value?.gid?.trim() ?? "";
  if (!spreadsheetId || !gid) {
    return null;
  }
  return `${spreadsheetId}\0${gid}`;
}

function withManualGoogleSheetCheckboxColumn(
  meta: GoogleSheetSyncMetadata,
  columnIndex: number,
): GoogleSheetSyncMetadata {
  const manualCandidate: GoogleSheetCheckboxCandidate = {
    columnIndex,
    count: 0,
    dataValidationCount: 0,
    boolValueCount: 0,
    header: "Manual",
  };
  const otherCandidates = (meta.checkboxCandidates ?? []).filter(
    (candidate) =>
      candidate.columnIndex !== columnIndex && candidate.header !== "Manual",
  );
  return {
    ...meta,
    checkboxColumnIndex: columnIndex,
    doneColumnIndex: columnIndex,
    checkboxColumnSource: "manual",
    checkboxColumnDetectionError: null,
    checkboxCandidates: [manualCandidate, ...otherCandidates],
  };
}

function withoutManualGoogleSheetSettings(
  meta: GoogleSheetSyncMetadata,
): GoogleSheetSyncMetadata {
  const checkboxCandidates = (meta.checkboxCandidates ?? []).filter(
    (candidate) => candidate.header !== "Manual",
  );

  return {
    ...meta,
    manualSheetTitle: null,
    sheetTitleSource: undefined,
    checkboxColumnIndex: fixedGoogleSheetCheckboxColumnIndex,
    doneColumnIndex: fixedGoogleSheetCheckboxColumnIndex,
    checkboxColumnSource: "fixed",
    checkboxColumnDetectionError: null,
    checkboxCandidates,
  };
}

function getSelectedGoogleSheetCheckboxColumnIndex(
  meta: GoogleSheetSyncMetadata | null,
  manualColumnInput?: string,
): number | null {
  return (
    getManualGoogleSheetCheckboxColumnIndex(meta, manualColumnInput) ??
    fixedGoogleSheetCheckboxColumnIndex
  );
}

function getGoogleSheetCheckboxColumnSource(
  meta: GoogleSheetSyncMetadata | null,
  manualColumnInput?: string,
): "metadata" | "manual" | "fixed" | "none" {
  const checkboxColumnIndex = getSelectedGoogleSheetCheckboxColumnIndex(
    meta,
    manualColumnInput,
  );
  if (checkboxColumnIndex === null || !meta) {
    return "none";
  }
  if (getManualGoogleSheetCheckboxColumnIndex(meta, manualColumnInput) !== null) {
    return "manual";
  }
  const manualCandidate = meta.checkboxCandidates?.find(
    (candidate) =>
      candidate.columnIndex === checkboxColumnIndex &&
      candidate.header === "Manual",
  );
  if (manualCandidate) {
    return "manual";
  }
  if (checkboxColumnIndex === fixedGoogleSheetCheckboxColumnIndex) {
    return "fixed";
  }
  if (meta.checkboxColumnSource === "metadata") {
    return "metadata";
  }
  return "fixed";
}

function getGoogleSheetStatusColumnIndex(
  meta: GoogleSheetSyncMetadata | null,
): number | null {
  if (!meta) {
    return null;
  }
  return isUsableSheetColumnIndex(meta.statusColumnIndex ?? null)
    ? (meta.statusColumnIndex as number)
    : null;
}

function isResolvedGoogleSheetTitle(value: string | null | undefined): boolean {
  const title = value?.trim() ?? "";
  return title.length > 0;
}

function unresolvedGoogleSheetTabMessage(gid: string): string {
  return `Could not resolve tab name for gid=${gid}. Re-import Google Sheet after Google connection.`;
}

function googleSheetDisplayName(
  sheetTitle: string | null | undefined,
  gid: string | null | undefined,
): string {
  const title = sheetTitle?.trim();
  if (title) {
    return `Google Sheet: ${title}`;
  }
  const value = gid?.trim();
  return value ? `Google Sheet gid=${value}` : "Google Sheet";
}

function getGoogleSheetWriteSheetTitle(
  meta: GoogleSheetSyncMetadata | null,
): string | null {
  const manualTitle = meta?.manualSheetTitle?.trim();
  return manualTitle || null;
}

function getGoogleSheetTitleSource(
  meta: GoogleSheetSyncMetadata | null,
): SheetTitleSource | null {
  return meta?.sheetTitleSource ?? null;
}

function withGoogleSheetTitle(
  meta: GoogleSheetSyncMetadata,
  sheetTitle: string,
  source: SheetTitleSource,
): GoogleSheetSyncMetadata {
  const title = sheetTitle.trim();
  return {
    ...meta,
    sheetTitle: title,
    manualSheetTitle: title,
    sheetTitleSource: source,
    sheetTitleResolutionError: null,
  };
}

function getDefaultGoogleSheetManualTitle(
  platform: PlatformMode,
): string | null {
  if (platform === "android") return defaultAndroidGoogleSheetTabName;
  if (platform === "ios") return defaultIosGoogleSheetTabName;
  if (platform === "unity") return defaultUnityGoogleSheetTabName;
  return null;
}

function getDefaultUploadedXlsxGoogleSheetTitle(
  platform: PlatformMode,
): string | null {
  if (platform === "android") return defaultAndroidGoogleSheetTabName;
  if (platform === "ios") return defaultIosGoogleSheetTabName;
  if (platform === "unity") return defaultUnityGoogleSheetTabName;
  return null;
}

function formatXlsxMatrixPreview(matrix: string[][]): string {
  return matrix
    .slice(0, 10)
    .map((row, index) => `${index + 1}: ${JSON.stringify(row.slice(0, 9))}`)
    .join("\n");
}

function isLegacyCheckColumnMissingWarning(warning: string): boolean {
  return /Check column not found; no checkbox-gated spec rows imported\./i.test(
    warning,
  );
}

function getGoogleSheetWritebackIndexSource(
  meta: GoogleSheetSyncMetadata | null,
): GoogleSheetWritebackTargetSource {
  return meta?.writebackSource === "uploadedXlsx"
    ? "uploadedXlsxStaircaseIndex"
    : "googleSheetImportStaircaseIndex";
}

function getGoogleSheetRowIndexReadRange(
  meta: GoogleSheetSyncMetadata | null,
  sheetTitle: string,
): string {
  const endColumn = isUnityStaircaseGoogleSheetMeta(meta) ? "I" : "Z";
  return `${quoteGoogleSheetTitleForA1(sheetTitle)}!A:${endColumn}`;
}

function getGoogleSheetRowBindingSource(
  meta: GoogleSheetSyncMetadata | null,
): "xlsxSourceRows" | "googleSheetSourceRows" | "none" {
  if (!meta) {
    return "none";
  }
  if (meta.writebackSource === "uploadedXlsx") {
    return "xlsxSourceRows";
  }
  return meta.rows.length > 0 ? "googleSheetSourceRows" : "none";
}

function normalizeGoogleSheetTitleForA1(sheetTitle: string): string {
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

function quoteGoogleSheetTitleForA1(sheetTitle: string): string {
  const normalizedTitle = normalizeGoogleSheetTitleForA1(sheetTitle);
  return `'${normalizedTitle.replace(/'/g, "''")}'`;
}

function buildGoogleSheetA1Range(
  sheetTitle: string,
  columnIndex: number,
  rowNumber: number,
): string {
  return `${quoteGoogleSheetTitleForA1(sheetTitle)}!${columnIndexToA1(
    columnIndex,
  )}${rowNumber}`;
}

function normalizeGoogleSheetEventName(value: string | null | undefined): string {
  return normalizeValue(value ?? "")
    .replace(/\s*\.\s*/g, ".")
    .replace(/[\s/\\-]+/g, ".")
    .replace(/\.+/g, ".")
    .replace(/^\./, "")
    .replace(/\.$/, "");
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
  gIsBooleanLike: boolean;
};

function valueCellToString(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim().replace(/\s+/g, " ");
}

function normalizeGoogleSheetHierarchyCell(value: string): string {
  return normalizeGoogleSheetEventName(value) || value.trim();
}

function buildGoogleSheetRowScanStates(
  rows: Array<{ rowNumber: number; row: unknown[] }>,
): GoogleSheetRowScanState[] {
  const levels = Array.from(
    { length: googleSheetHierarchyColumnCount },
    () => "",
  );
  return rows.map(({ rowNumber, row: rawRow }) => {
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
    const gValue = row[fixedGoogleSheetCheckboxColumnIndex]?.trim() ?? "";
    const gIsBooleanLike = isGoogleSheetBooleanText(gValue);

    return {
      rowNumber,
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
      gIsBooleanLike,
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
    source: GoogleSheetWritebackTargetSource;
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
    range: buildGoogleSheetA1Range(
      options.sheetTitle,
      fixedGoogleSheetCheckboxColumnIndex,
      state.rowNumber,
    ),
    leaf: options.leaf,
    parent: options.parent,
    gValue: state.gValue,
    gIsBooleanLike: state.gIsBooleanLike,
    actualColumns: state.actualColumns,
    rawRow: state.row,
    indexed: options.indexed,
    reason: options.reason,
    source: options.source,
  };
}

function isUnityStaircaseGoogleSheetMeta(
  meta: GoogleSheetSyncMetadata | null,
): boolean {
  return (
    meta?.detectedParser === "unity-staircase" ||
    meta?.selectedPlatform === "unity"
  );
}

function buildGoogleSheetMappedRowIndexFromSourceRows(
  meta: GoogleSheetSyncMetadata,
  writeSheetTitle: string,
  indexSource: GoogleSheetWritebackTargetSource,
  startedAt: number,
): GoogleSheetRowIndexState | null {
  const byEventName = new Map<
    string,
    {
      eventName: string;
      normalizedEventName: string;
      rowNumbers: number[];
      source?: GoogleSheetWritebackTargetSource;
      rawRows: string[][];
      rowDetails: GoogleSheetRowIndexRowDebug[];
    }
  >();
  const debugRows: GoogleSheetRowIndexRowDebug[] = [];
  const sourceRows = (meta.rows ?? [])
    .filter((row) => row.sourceRowNumber > 0)
    .sort((a, b) => a.sourceRowNumber - b.sourceRowNumber);
  const staircaseRowCount =
    meta.staircaseRows?.reduce(
      (max, row) => Math.max(max, row.sourceRowNumber),
      0,
    ) ?? 0;
  const rowCount = Math.max(
    staircaseRowCount,
    sourceRows.reduce((max, row) => Math.max(max, row.sourceRowNumber), 0),
  );

  for (const sourceRow of sourceRows) {
    const eventName = (sourceRow.eventName ?? "").trim();
    const normalizedEventName = normalizeGoogleSheetEventName(
      sourceRow.normalizedEventName || eventName,
    );
    if (
      !eventName ||
      !normalizedEventName ||
      normalizedEventName.split(".").filter(Boolean).length < 2
    ) {
      continue;
    }

    const rawRow = sourceRow.rawRow ?? [];
    const actualColumns = rawRow
      .slice(0, 6)
      .flatMap((cell, columnIndex) =>
        cell.trim() ? [columnIndexToA1(columnIndex)] : [],
      );
    const fallbackActualColumns =
      actualColumns.length > 0
        ? actualColumns
        : (sourceRow.sourcePathColumns ?? []).map((_, columnIndex) =>
            columnIndexToA1(columnIndex),
          );
    const gValue = rawRow[fixedGoogleSheetCheckboxColumnIndex]?.trim() ?? "";
    const rowDebug: GoogleSheetRowIndexRowDebug = {
      rowNumber: sourceRow.sourceRowNumber,
      eventName,
      normalizedEventName,
      range: buildGoogleSheetA1Range(
        writeSheetTitle,
        fixedGoogleSheetCheckboxColumnIndex,
        sourceRow.sourceRowNumber,
      ),
      leaf: true,
      parent: false,
      gValue,
      gIsBooleanLike: isGoogleSheetBooleanText(gValue),
      actualColumns: fallbackActualColumns,
      rawRow,
      indexed: true,
      reason: null,
      source: indexSource,
    };
    debugRows.push(rowDebug);

    const current =
      byEventName.get(normalizedEventName) ?? {
        eventName,
        normalizedEventName,
        rowNumbers: [],
        source: indexSource,
        rawRows: [],
        rowDetails: [],
      };
    if (!current.rowNumbers.includes(sourceRow.sourceRowNumber)) {
      current.rowNumbers.push(sourceRow.sourceRowNumber);
      current.rawRows.push(rawRow);
      current.rowDetails.push(rowDebug);
    }
    byEventName.set(normalizedEventName, current);
    console.log(
      `[googleRowIndex] indexed mapped row=${sourceRow.sourceRowNumber} event=${eventName} range=${rowDebug.range} actualColumns=${
        fallbackActualColumns.join(",") || "none"
      } leaf=true parent=false gValue=${gValue} gIsBooleanLike=${
        rowDebug.gIsBooleanLike
      }`,
    );
  }

  const entries = [...byEventName.values()].sort((a, b) =>
    a.normalizedEventName.localeCompare(b.normalizedEventName),
  );
  console.log(`[googleSheetWritebackIndex] rows=${sourceRows.length}`);
  console.log(`[googleSheetWritebackIndex] mappedEvents=${entries.length}`);
  if (entries.length === 0) {
    console.log("[googleSheetWritebackIndex] build failed error=no mapped events");
    return null;
  }

  const rowIndex: GoogleSheetRowIndexState = {
    spreadsheetId: meta.spreadsheetId,
    sheetTitle: writeSheetTitle,
    range: getGoogleSheetRowIndexReadRange(meta, writeSheetTitle),
    cacheVersion: googleSheetRowIndexCacheVersion,
    source: indexSource,
    rowCount,
    indexedEventCount: entries.length,
    entries,
    debugRows,
    builtAt: Date.now(),
  };
  console.log(
    `[googleSheetWritebackIndex] build success durationMs=${Date.now() - startedAt}`,
  );
  console.log(`[googleSheetWritebackIndex] build success mappedEvents=${entries.length}`);
  return rowIndex;
}

function getGoogleSheetRowIndexEntry(
  rowIndex: GoogleSheetRowIndexState | null,
  eventName: string | null | undefined,
): GoogleSheetRowIndexEntry | null {
  const normalizedEventName = normalizeGoogleSheetEventName(eventName);
  if (!rowIndex || !normalizedEventName) {
    return null;
  }
  return (
    rowIndex.entries.find(
      (entry) => entry.normalizedEventName === normalizedEventName,
    ) ?? null
  );
}

function getGoogleSheetRowIndexDebugRow(
  rowIndex: GoogleSheetRowIndexState | null,
  eventName: string | null | undefined,
): GoogleSheetRowIndexRowDebug | null {
  const normalizedEventName = normalizeGoogleSheetEventName(eventName);
  if (!rowIndex || !normalizedEventName) {
    return null;
  }
  return (
    rowIndex.debugRows?.find(
      (row) => row.normalizedEventName === normalizedEventName,
    ) ??
    getGoogleSheetRowIndexEntry(rowIndex, eventName)?.rowDetails?.[0] ??
    null
  );
}

function formatGoogleSheetRowIndexDebugLine(
  rowIndex: GoogleSheetRowIndexState | null,
  eventName: string,
  options: {
    checkboxColumnIndex: number | null;
    writeSheetTitle: string | null;
  },
): string {
  const entry = getGoogleSheetRowIndexEntry(rowIndex, eventName);
  const debugRow = getGoogleSheetRowIndexDebugRow(rowIndex, eventName);
  const rowNumber =
    entry?.rowNumbers.length === 1
      ? entry.rowNumbers[0]
      : debugRow?.rowNumber ?? null;
  const range =
    debugRow?.range ??
    (rowNumber !== null &&
    options.checkboxColumnIndex !== null &&
    options.writeSheetTitle !== null
      ? buildGoogleSheetA1Range(
          options.writeSheetTitle,
          options.checkboxColumnIndex,
          rowNumber,
        )
      : "null");
  return `${eventName} -> ${rowNumber ?? "null"} -> ${range} -> leaf=${
    debugRow?.leaf ?? Boolean(entry)
  } -> parent=${debugRow?.parent ?? false} -> gValue=${
    debugRow?.gValue || "null"
  } -> gIsBooleanLike=${debugRow?.gIsBooleanLike ?? false}`;
}

function findGoogleSheetRowIndexCandidates(
  rowIndex: GoogleSheetRowIndexState | null,
  eventName: string,
): string {
  const normalizedEventName = normalizeGoogleSheetEventName(eventName);
  if (!rowIndex || !normalizedEventName) {
    return "none";
  }
  const parts = normalizedEventName.split(".").filter(Boolean);
  const candidates = rowIndex.entries
    .filter((entry) => {
      if (
        entry.normalizedEventName.includes(normalizedEventName) ||
        normalizedEventName.includes(entry.normalizedEventName)
      ) {
        return true;
      }
      const overlap = parts.filter((part) =>
        entry.normalizedEventName.includes(part),
      ).length;
      return overlap >= Math.max(2, Math.min(parts.length, 3));
    })
    .slice(0, 5)
    .map(
      (entry) =>
        `${entry.eventName || entry.normalizedEventName} rows=${entry.rowNumbers.join(",")}`,
    );
  return candidates.length > 0 ? candidates.join(" | ") : "none";
}

function findGoogleSheetRowIndexClosestKeys(
  rowIndex: GoogleSheetRowIndexState | null,
  eventName: string,
): string[] {
  const normalizedEventName = normalizeGoogleSheetEventName(eventName);
  if (!rowIndex || !normalizedEventName) {
    return [];
  }
  const parts = normalizedEventName.split(".").filter(Boolean);
  return rowIndex.entries
    .map((entry) => {
      const overlap = parts.filter((part) =>
        entry.normalizedEventName.includes(part),
      ).length;
      const includes =
        entry.normalizedEventName.includes(normalizedEventName) ||
        normalizedEventName.includes(entry.normalizedEventName);
      return {
        entry,
        score: overlap + (includes ? 10 : 0),
      };
    })
    .filter((item) => item.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.entry.normalizedEventName.localeCompare(b.entry.normalizedEventName),
    )
    .slice(0, 5)
    .map(
      ({ entry }) =>
        `${entry.normalizedEventName} rows=${entry.rowNumbers.join(",")}`,
    );
}

function getGoogleSheetRowIndexWriteTarget(
  rowIndex: GoogleSheetRowIndexState | null,
  eventName: string,
): GoogleSheetRowIndexWriteTarget {
  const normalizedEventName = normalizeGoogleSheetEventName(eventName);
  const entry = getGoogleSheetRowIndexEntry(rowIndex, eventName);
  const debugRow = getGoogleSheetRowIndexDebugRow(rowIndex, eventName);
  if (!entry) {
    console.warn(
      `[googleRowIndexLookup] event=${eventName} normalized=${
        normalizedEventName || "null"
      } result=null`,
    );
    console.warn(
      `[googleRowIndexLookup] closestKeys=${JSON.stringify(
        findGoogleSheetRowIndexClosestKeys(rowIndex, eventName),
      )}`,
    );
    return {
      rowNumber: null,
      reason: "No matching Google Sheet event row",
      candidates: findGoogleSheetRowIndexCandidates(rowIndex, eventName),
      debugRow,
    };
  }
  if (entry.rowNumbers.length !== 1) {
    return {
      rowNumber: null,
      reason: "Duplicate Google Sheet rows for event",
      candidates: entry.rowNumbers.join(", "),
      debugRow,
    };
  }
  return {
    rowNumber: entry.rowNumbers[0],
    reason: null,
    candidates: "",
    debugRow,
  };
}

function logGoogleSheetRowIndexDiagnostics(
  rowIndex: GoogleSheetRowIndexState,
): void {
  console.log(
    `[googleRowIndex] sheetTitle=${rowIndex.sheetTitle} rowsRead=${rowIndex.rowCount} indexSize=${rowIndex.indexedEventCount}`,
  );
  for (const eventName of googleRowIndexDiagnosticEvents) {
    const entry = getGoogleSheetRowIndexEntry(rowIndex, eventName);
    const row = entry?.rowNumbers.length === 1 ? entry.rowNumbers[0] : null;
    console.log(
      `[googleRowIndex] has ${eventName}=${Boolean(entry)} row=${
        row ?? "null"
      }`,
    );
    console.log(
      `[googleRowIndex] sample ${formatGoogleSheetRowIndexDebugLine(
        rowIndex,
        eventName,
        {
          checkboxColumnIndex: fixedGoogleSheetCheckboxColumnIndex,
          writeSheetTitle: rowIndex.sheetTitle,
        },
      )}`,
    );
  }
}

function buildGoogleSheetRowIndexFromSourceMetadata(
  meta: GoogleSheetSyncMetadata | null,
): GoogleSheetRowIndexState | null {
  const startedAt = Date.now();
  const indexSource = getGoogleSheetWritebackIndexSource(meta);
  console.log(`[googleSheetWritebackIndex] build start source=${indexSource}`);
  const writeSheetTitle = getGoogleSheetWriteSheetTitle(meta);
  const rawSourceRows =
    meta?.staircaseRows && meta.staircaseRows.length > 0
      ? meta.staircaseRows
      : meta?.rows ?? [];
  if (!meta || writeSheetTitle === null || rawSourceRows.length === 0) {
    console.log(`[googleSheetWritebackIndex] rows=${rawSourceRows.length}`);
    console.log("[googleSheetWritebackIndex] mappedEvents=0");
    console.log("[googleSheetWritebackIndex] build failed error=missing metadata rows");
    return null;
  }
  if (isUnityStaircaseGoogleSheetMeta(meta)) {
    return buildGoogleSheetMappedRowIndexFromSourceRows(
      meta,
      writeSheetTitle,
      indexSource,
      startedAt,
    );
  }

  const byEventName = new Map<
    string,
    {
      eventName: string;
      normalizedEventName: string;
      rowNumbers: number[];
      source?: GoogleSheetWritebackTargetSource;
      rawRows: string[][];
      rowDetails: GoogleSheetRowIndexRowDebug[];
    }
  >();
  const debugRows: GoogleSheetRowIndexRowDebug[] = [];
  const sourceRows = rawSourceRows
    .filter((row) => row.sourceRowNumber > 0)
    .sort((a, b) => a.sourceRowNumber - b.sourceRowNumber)
    .map((row) => ({
      rowNumber: row.sourceRowNumber,
      row: row.rawRow ?? [],
    }));
  const rowCount = sourceRows.reduce(
    (max, row) => Math.max(max, row.rowNumber),
    0,
  );
  const states = buildGoogleSheetRowScanStates(sourceRows);

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
        source: indexSource,
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
        sheetTitle: writeSheetTitle,
        source: indexSource,
        indexed: true,
        leaf: true,
        parent: false,
        reason: null,
      });
      debugRows.push(rowDebug);
      addEventIndexEntry(state, rowDebug);
      console.log(
        `[googleRowIndex] indexed row=${state.rowNumber} event=${state.eventName} range=${rowDebug.range} actualColumns=${
          state.actualColumns.join(",") || "none"
        } leaf=true parent=false gValue=${state.gValue} gIsBooleanLike=${
          state.gIsBooleanLike
        }`,
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
        sheetTitle: writeSheetTitle,
        source: indexSource,
        indexed: false,
        leaf: false,
        parent: true,
        reason: "parent row",
      });
      debugRows.push(rowDebug);
      console.log(
        `[googleRowIndex] skipped parent row=${state.rowNumber} event=${state.eventName} actualColumns=${
          state.actualColumns.join(",") || "none"
        } leaf=false parent=true gValue=${state.gValue} gIsBooleanLike=${
          state.gIsBooleanLike
        }`,
      );
    }
  }

  const entries = [...byEventName.values()].sort((a, b) =>
    a.normalizedEventName.localeCompare(b.normalizedEventName),
  );
  console.log(`[googleSheetWritebackIndex] rows=${rawSourceRows.length}`);
  console.log(`[googleSheetWritebackIndex] mappedEvents=${entries.length}`);
  for (const eventName of googleRowIndexDiagnosticEvents) {
    const debugIndex: GoogleSheetRowIndexState = {
      spreadsheetId: meta.spreadsheetId,
      sheetTitle: writeSheetTitle,
      range: getGoogleSheetRowIndexReadRange(meta, writeSheetTitle),
      cacheVersion: googleSheetRowIndexCacheVersion,
      source: indexSource,
      rowCount,
      indexedEventCount: entries.length,
      entries,
      debugRows,
      builtAt: Date.now(),
    };
    console.log(
      `[googleRowIndex] sample ${formatGoogleSheetRowIndexDebugLine(
        debugIndex,
        eventName,
        {
          checkboxColumnIndex: fixedGoogleSheetCheckboxColumnIndex,
          writeSheetTitle,
        },
      )}`,
    );
  }
  if (entries.length === 0) {
    console.log("[googleSheetWritebackIndex] build failed error=no mapped events");
    return null;
  }

  const rowIndex = {
    spreadsheetId: meta.spreadsheetId,
    sheetTitle: writeSheetTitle,
    range: getGoogleSheetRowIndexReadRange(meta, writeSheetTitle),
    cacheVersion: googleSheetRowIndexCacheVersion,
    source: indexSource,
    rowCount,
    indexedEventCount: entries.length,
    entries,
    debugRows,
    builtAt: Date.now(),
  };
  console.log(
    `[googleSheetWritebackIndex] build success durationMs=${Date.now() - startedAt}`,
  );
  console.log(`[googleSheetWritebackIndex] build success mappedEvents=${entries.length}`);
  return rowIndex;
}

function buildSpecRowsFromGoogleSheetRowIndex(
  rowIndex: GoogleSheetRowIndexState,
): AnalyticsSpecRow[] {
  const indexedRows = (rowIndex.debugRows ?? [])
    .filter((row) => row.indexed && row.leaf && row.rowNumber > 0)
    .sort((a, b) => a.rowNumber - b.rowNumber);

  return indexedRows.map((row) => {
    const hierarchy = row.eventName.split(".").filter(Boolean);
    const sheetRowIndex = row.rowNumber - 1;
    return {
      id: `spec-${sheetRowIndex}`,
      hierarchy,
      cells: {
        label: hierarchy[hierarchy.length - 1] ?? row.eventName,
        eventPath: row.eventName,
        description: "",
        value: null,
        sheetRowIndex,
        sourceRowNumber: row.rowNumber,
        level: Math.max(0, hierarchy.length - 1),
      },
      status: "not_checked",
      meta: {
        sheetRowIndex,
        sourceRowNumber: row.rowNumber,
        level: Math.max(0, hierarchy.length - 1),
        eventName: row.eventName,
        normalizedEventName: row.normalizedEventName,
        googleCheckRange: row.range,
        fullPath: row.eventName,
        sourcePathColumns: hierarchy,
        actualColumns: row.actualColumns,
        gValue: row.gValue,
        gIsBooleanLike: row.gIsBooleanLike,
        rawRow: row.rawRow ?? [],
      },
    } satisfies AnalyticsSpecRow;
  });
}

function getPassedLogGoogleSheetEventName(log: ParsedLogEntry): string {
  const eventPath = log.eventPath?.trim() ?? "";
  const value = log.value?.trim() ?? "";
  const reconstructed = [eventPath, value].filter(Boolean).join(".");
  return reconstructed || log.extracted?.trim() || "";
}

function isGoogleSheetRowIndexReadyForMeta(
  rowIndex: GoogleSheetRowIndexState | null,
  meta: GoogleSheetSyncMetadata | null,
): boolean {
  const writeSheetTitle = getGoogleSheetWriteSheetTitle(meta);
  const expectedSource = getGoogleSheetWritebackIndexSource(meta);
  return Boolean(
    rowIndex &&
      meta &&
      rowIndex.spreadsheetId === meta.spreadsheetId &&
      rowIndex.cacheVersion === googleSheetRowIndexCacheVersion &&
      rowIndex.source === expectedSource &&
      writeSheetTitle &&
      rowIndex.sheetTitle === writeSheetTitle &&
      rowIndex.indexedEventCount > 0,
  );
}

function isGoogleSheetRowBindingReady(
  meta: GoogleSheetSyncMetadata | null,
  rowIndex: GoogleSheetRowIndexState | null,
  importResult: ParsedSpecResult | null,
): boolean {
  if (!meta || !importResult) {
    return false;
  }
  const indexReady = isGoogleSheetRowIndexReadyForMeta(rowIndex, meta);
  if (meta.writebackSource === "uploadedXlsx") {
    return indexReady;
  }
  return meta.rows.length > 0 && indexReady;
}

function retitleGoogleSheetRowIndex(
  rowIndex: GoogleSheetRowIndexState | null,
  sheetTitle: string | null,
): GoogleSheetRowIndexState | null {
  const title = sheetTitle?.trim();
  if (!rowIndex || !title) {
    return null;
  }
  const endColumn = /!A:I\s*$/i.test(rowIndex.range) ? "I" : "Z";
  return {
    ...rowIndex,
    sheetTitle: title,
    range: `${quoteGoogleSheetTitleForA1(title)}!A:${endColumn}`,
    cacheVersion: rowIndex.cacheVersion,
    debugRows: rowIndex.debugRows?.map((row) => ({
      ...row,
      range: buildGoogleSheetA1Range(
        title,
        fixedGoogleSheetCheckboxColumnIndex,
        row.rowNumber,
      ),
    })),
    entries: rowIndex.entries.map((entry) => ({
      ...entry,
      rowDetails: entry.rowDetails?.map((row) => ({
        ...row,
        range: buildGoogleSheetA1Range(
          title,
          fixedGoogleSheetCheckboxColumnIndex,
          row.rowNumber,
        ),
      })),
    })),
    builtAt: Date.now(),
  };
}

function getRowMetaNumber(
  row: AnalyticsSpecRow,
  key: string,
): number | null {
  const value = row.meta?.[key] ?? row.cells[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function getRowMetaStringArray(
  row: AnalyticsSpecRow,
  key: string,
): string[] {
  const value = row.meta?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function getSpecRowSourceRowNumber(row: AnalyticsSpecRow): number | null {
  const sourceRowNumber = getRowMetaNumber(row, "sourceRowNumber");
  if (sourceRowNumber !== null && sourceRowNumber > 0) {
    return sourceRowNumber;
  }
  const sheetRowIndex = getRowMetaNumber(row, "sheetRowIndex");
  return sheetRowIndex === null ? null : sheetRowIndex + 1;
}

function getSpecRowGoogleSheetEventName(row: AnalyticsSpecRow): string {
  const metaEventName =
    typeof row.meta?.eventName === "string" ? row.meta.eventName.trim() : "";
  if (metaEventName) {
    return metaEventName;
  }
  return [row.cells.eventPath, row.cells.value].filter(Boolean).join(".");
}

function buildGoogleSheetStaircaseRowsFromMatrix(
  matrix: string[][],
): GoogleSheetStaircaseRow[] {
  return matrix
    .map((rawRow, sourceRowIndex) => ({
      sourceRowIndex,
      sourceRowNumber: sourceRowIndex + 1,
      rawRow: rawRow.map(valueCellToString),
    }))
    .filter((row) => row.rawRow.some((cell) => cell.trim().length > 0));
}

function buildGoogleSheetSourceRowsFromParsedRows(
  rows: AnalyticsSpecRow[],
  sheetTitle: string | null,
): GoogleSheetSourceRow[] {
  return rows.flatMap((row, importedIndex) => {
    const sourceRowNumber = getSpecRowSourceRowNumber(row);
    if (sourceRowNumber === null || sourceRowNumber <= 0) {
      return [];
    }
    const eventName = getSpecRowGoogleSheetEventName(row);
    return [
      {
        rowId: row.id,
        sourceRowIndex: sourceRowNumber - 1,
        sourceRowNumber,
        importedIndex,
        eventName,
        normalizedEventName: normalizeGoogleSheetEventName(eventName),
        googleCheckRange: sheetTitle
          ? buildGoogleSheetA1Range(
              sheetTitle,
              fixedGoogleSheetCheckboxColumnIndex,
              sourceRowNumber,
            )
          : null,
        sourcePathColumns: getRowMetaStringArray(row, "sourcePathColumns"),
        rawRow: getRowMetaStringArray(row, "rawRow"),
      },
    ];
  });
}

function resolveGoogleSheetImportStaircaseWriteTarget(
  update: PendingGoogleSheetUpdate,
  options: {
    writeSheetTitle: string;
    rowIndex: GoogleSheetRowIndexState | null;
  },
): GoogleSheetWriteTargetResolution {
  const targetSource =
    options.rowIndex?.source ?? "googleSheetImportStaircaseIndex";
  const noMatchReason =
    targetSource === "uploadedXlsxStaircaseIndex"
      ? "No matching XLSX event row"
      : "No matching Google Sheet event row";
  const normalizedEventName = normalizeGoogleSheetEventName(update.eventName);
  if (!normalizedEventName) {
    return {
      rowNumber: null,
      range: null,
      source: null,
      reason: noMatchReason,
      candidates: "",
      debugRow: null,
    };
  }
  if (!options.rowIndex) {
    return {
      rowNumber: null,
      range: null,
      source: null,
      reason: "Import staircase writeback index is not built",
      candidates: "",
      debugRow: null,
    };
  }

  const entry = getGoogleSheetRowIndexEntry(
    options.rowIndex,
    normalizedEventName,
  );
  const debugRow = getGoogleSheetRowIndexDebugRow(
    options.rowIndex,
    normalizedEventName,
  );
  if (!entry) {
    return {
      rowNumber: null,
      range: null,
      source: null,
      reason: noMatchReason,
      candidates: findGoogleSheetRowIndexCandidates(
        options.rowIndex,
        update.eventName,
      ),
      debugRow,
    };
  }

  if (entry.rowNumbers.length !== 1) {
    const candidates = entry.rowNumbers
      .map((rowNumber) =>
        buildGoogleSheetA1Range(
          options.writeSheetTitle,
          fixedGoogleSheetCheckboxColumnIndex,
          rowNumber,
        ),
      )
      .join(", ");
    return {
      rowNumber: null,
      range: null,
      source: null,
      reason: "Duplicate Google Sheet rows for event",
      candidates,
      debugRow,
    };
  }

  const rowNumber = entry.rowNumbers[0];
  return {
    rowNumber,
    range: buildGoogleSheetA1Range(
      options.writeSheetTitle,
      fixedGoogleSheetCheckboxColumnIndex,
      rowNumber,
    ),
    source: targetSource,
    reason: null,
    candidates: "",
    debugRow: debugRow ?? entry.rowDetails?.[0] ?? null,
  };
}

function getGoogleSheetHeaderRowNumber(
  meta: GoogleSheetSyncMetadata | null,
): number | null {
  if (!meta) {
    return null;
  }
  if (
    typeof meta.headerRowNumber === "number" &&
    Number.isInteger(meta.headerRowNumber) &&
    meta.headerRowNumber > 0
  ) {
    return meta.headerRowNumber;
  }
  if (
    typeof meta.headerRowIndex === "number" &&
    Number.isInteger(meta.headerRowIndex) &&
    meta.headerRowIndex >= 0
  ) {
    return meta.headerRowIndex + 1;
  }
  return null;
}

function getSuspiciousSourceRowReason(
  meta: GoogleSheetSyncMetadata,
  sourceRow: GoogleSheetSourceRow | null | undefined,
  specRow: AnalyticsSpecRow | null | undefined,
): string | null {
  if (!sourceRow) {
    return "Missing source row mapping";
  }

  const sourceRowNumber = sourceRow.sourceRowNumber;
  if (!Number.isInteger(sourceRowNumber) || sourceRowNumber <= 0) {
    return "Missing source row mapping";
  }

  const headerRowNumber = getGoogleSheetHeaderRowNumber(meta);
  if (headerRowNumber !== null && sourceRowNumber <= headerRowNumber) {
    return `sourceRowNumber ${sourceRowNumber} <= header row ${headerRowNumber}`;
  }

  if (
    Number.isInteger(sourceRow.sourceRowIndex) &&
    sourceRow.sourceRowIndex + 1 !== sourceRowNumber
  ) {
    return `sourceRowIndex ${sourceRow.sourceRowIndex} does not match sourceRowNumber ${sourceRowNumber}`;
  }

  const specSourceRowNumber = specRow
    ? getSpecRowSourceRowNumber(specRow)
    : null;
  if (specSourceRowNumber !== null && specSourceRowNumber !== sourceRowNumber) {
    return `sourceRowNumber ${sourceRowNumber} does not match spec sourceRowNumber ${specSourceRowNumber}`;
  }

  return null;
}

function nextLiveLogId(): string {
  return `live-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function toDisplayLiveLine(raw: string): string {
  const noAnsi = raw.replace(
    // eslint-disable-next-line no-control-regex
    /\u001b\[[0-9;]*m/g,
    "",
  );
  const compact = noAnsi.replace(/\s+/g, " ").trim();
  const withoutServicePrefix = compact.replace(/^\[AppMetricaService\]\s*/i, "");
  const payload = extractAnalyticsPayload(withoutServicePrefix);
  if (payload !== null) {
    return finalizeLivePayload(payload);
  }
  return finalizeLivePayload(
    withoutServicePrefix.replace(/^Analytic report:\s*/i, ""),
  );
}

function finalizeLivePayload(value: string): string {
  return value
    .replace(/<\/color>\s*$/i, "")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .trim();
}

function extractLiveAnalyticsPayload(rawLine: string): string | null {
  const extracted = extractAnalyticsPayload(rawLine);
  if (extracted !== null) {
    return extracted;
  }

  const trimmed = rawLine.trim();
  return /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/i.test(trimmed)
    ? trimmed
    : null;
}

function parseUnityLiveStreamEntry(data: string): UnityLiveStreamEntry | null {
  const trimmed = data.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as Partial<UnityLiveStreamEntry> | null;
    if (parsed && typeof parsed.rawLine === "string") {
      const rawLine = parsed.rawLine.replace(/\r$/, "");
      if (!rawLine) {
        return null;
      }
      const analyticsLine =
        typeof parsed.analyticsLine === "string" && parsed.analyticsLine.trim()
          ? parsed.analyticsLine.trim()
          : null;
      return {
        rawLine,
        analyticsLine,
        timestamp:
          typeof parsed.timestamp === "number" ? parsed.timestamp : undefined,
        extractedEvent:
          typeof parsed.extractedEvent === "string" &&
          parsed.extractedEvent.trim()
            ? parsed.extractedEvent.trim()
            : null,
        analyticsType:
          parsed.analyticsType === "AppsFlyer" ||
          parsed.analyticsType === "AppMetrica" ||
          parsed.analyticsType === "ABTest"
            ? parsed.analyticsType
            : null,
        detectedProjectPath:
          typeof parsed.detectedProjectPath === "string" &&
          parsed.detectedProjectPath.trim()
            ? parsed.detectedProjectPath.trim()
            : null,
        detectedProductName:
          typeof parsed.detectedProductName === "string" &&
          parsed.detectedProductName.trim()
            ? parsed.detectedProductName.trim()
            : null,
      };
    }
  } catch {
    // Older Unity stream payloads were plain strings.
  }

  const analyticsLine =
    trimmed.includes("Analytic report:") &&
    extractLiveAnalyticsPayload(trimmed) !== null
      ? trimmed
      : null;
  return {
    rawLine: trimmed,
    analyticsLine,
  };
}

function normalizeEventGroupPath(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_\s/-]+/g, ".")
    .replace(/\.+/g, ".")
    .replace(/^\./, "")
    .replace(/\.$/, "");
}

function specRowEventPath(row: AnalyticsSpecRow): string {
  const eventPath = row.cells.eventPath;
  if (eventPath !== null && eventPath !== undefined && eventPath !== "") {
    return String(eventPath);
  }
  return row.hierarchy.join(".");
}

function eventPathMatchesGroup(path: string, groupPath: string): boolean {
  const normalizedPath = normalizeEventGroupPath(path);
  const normalizedGroupPath = normalizeEventGroupPath(groupPath);
  return (
    normalizedPath === normalizedGroupPath ||
    normalizedPath.startsWith(`${normalizedGroupPath}.`) ||
    normalizedPath.includes(`.${normalizedGroupPath}.`) ||
    normalizedPath.endsWith(`.${normalizedGroupPath}`)
  );
}

function isAndroidEventGroupTab(
  activeGroup: EventGroupTabId,
): activeGroup is AndroidEventGroupTabId {
  return androidEventGroupTabIdSet.has(activeGroup);
}

function isUnityEventGroupTab(
  activeGroup: EventGroupTabId,
): activeGroup is UnityEventGroupTabId {
  return unityEventGroupTabIdSet.has(activeGroup);
}

function isEventGroupTabAvailableForPlatform(
  activeGroup: EventGroupTabId,
  platform: PlatformMode,
): boolean {
  return platformUsesSdkEventGroupTabs(platform)
    ? isUnityEventGroupTab(activeGroup)
    : isAndroidEventGroupTab(activeGroup);
}

function unknownToSearchText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(unknownToSearchText).filter(Boolean).join(" ");
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .map(unknownToSearchText)
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

function inferUnityAnalyticsTypeFromText(text: string): UnityEventGroupTabId {
  const lower = text.toLowerCase();
  if (/(?:appsflyer|apps\s+flyer)/.test(lower)) {
    return "appsflyer";
  }
  if (/(?:ab\.test|a\/b|ab test|a-b test|ab_test)/.test(lower)) {
    return "ab_test";
  }
  return "appmetrica";
}

function normalizeUnityAnalyticsTypeValue(
  value: unknown,
): UnityEventGroupTabId | null {
  const text = unknownToSearchText(value).toLowerCase().trim();
  if (!text) {
    return null;
  }
  if (/(?:appsflyer|apps\s+flyer)/.test(text)) {
    return "appsflyer";
  }
  if (/(?:ab\.test|a\/b|ab test|a-b test|ab_test)/.test(text)) {
    return "ab_test";
  }
  if (/(?:appmetrica|app\s+metrica|yandex\s+metrica)/.test(text)) {
    return "appmetrica";
  }
  return null;
}

function getUnityAnalyticsTypeFromExplicitFields(
  values: unknown[],
): UnityEventGroupTabId | null {
  for (const value of values) {
    const type = normalizeUnityAnalyticsTypeValue(value);
    if (type !== null) {
      return type;
    }
  }
  return null;
}

function getUnityRowAnalyticsType(row: AnalyticsSpecRow): UnityEventGroupTabId {
  const explicitFieldNames = [
    "analyticsType",
    "analyticsSource",
    "analytics",
    "source",
    "category",
    "eventType",
    "type",
  ];
  for (const fieldName of explicitFieldNames) {
    const typeFromMeta = normalizeUnityAnalyticsTypeValue(row.meta?.[fieldName]);
    if (typeFromMeta !== null) {
      return typeFromMeta;
    }
    const typeFromCells = normalizeUnityAnalyticsTypeValue(row.cells[fieldName]);
    if (typeFromCells !== null) {
      return typeFromCells;
    }
  }

  return inferUnityAnalyticsTypeFromText(
    [
      specRowEventPath(row),
      row.hierarchy.join("."),
      row.cells.description,
      row.cells.parameterDescription,
      row.cells.value,
      row.meta?.description,
      row.meta?.parameterDescription,
      row.meta?.sourcePathColumns,
      row.meta?.rawRow,
    ]
      .map(unknownToSearchText)
      .filter(Boolean)
      .join(" "),
  );
}

function doesUnityRowMatchEventGroup(
  row: AnalyticsSpecRow,
  activeGroup: EventGroupTabId,
): boolean {
  if (activeGroup === "all" || !isUnityEventGroupTab(activeGroup)) {
    return true;
  }
  return getUnityRowAnalyticsType(row) === activeGroup;
}

function getUnityLogAnalyticsType(
  log: ParsedLogEntry,
  rows: AnalyticsSpecRow[] | null,
): UnityEventGroupTabId {
  const explicit = getUnityAnalyticsTypeFromExplicitFields([
    log.analyticsType,
    log.analyticsSource,
  ]);
  if (explicit !== null) {
    return explicit;
  }

  const matchedRow =
    log.matchedRowId && rows
      ? rows.find((row) => row.id === log.matchedRowId) ?? null
      : null;
  if (matchedRow !== null) {
    return getUnityRowAnalyticsType(matchedRow);
  }

  return inferUnityAnalyticsTypeFromText(
    [log.extracted, log.normalizedEventName, log.eventPath, log.value, log.raw]
      .map(unknownToSearchText)
      .filter(Boolean)
      .join(" "),
  );
}

function doesUnityLogMatchEventGroup(
  log: ParsedLogEntry,
  activeGroup: EventGroupTabId,
  rows: AnalyticsSpecRow[] | null,
): boolean {
  if (activeGroup === "all" || !isUnityEventGroupTab(activeGroup)) {
    return true;
  }
  return getUnityLogAnalyticsType(log, rows) === activeGroup;
}

function doesRowMatchEventGroup(
  row: AnalyticsSpecRow,
  activeGroup: EventGroupTabId,
  platform: PlatformMode,
): boolean {
  if (activeGroup === "all") {
    return true;
  }
  if (platformUsesSdkEventGroupTabs(platform)) {
    return doesUnityRowMatchEventGroup(row, activeGroup);
  }
  if (!isAndroidEventGroupTab(activeGroup)) {
    return true;
  }

  return eventPathMatchesGroup(
    specRowEventPath(row),
    eventGroupPathByTab[activeGroup],
  );
}

function liveDuplicateEventName(extracted: string | null): string | null {
  if (!extracted) {
    return null;
  }

  const normalized = normalizeValue(
    normalizeAnalyticsEventCandidate(extracted).normalized,
  );
  if (!normalized) {
    return null;
  }

  return normalized;
}

function buildTableRows(
  result: ParsedSpecResult | null,
  specSource: AnalyticsSpecRow[] | null,
) {
  if (result === null) {
    return [];
  }
  const source = specSource ?? result.rows;
  return source.map(specToTableRowModel);
}

function getUnknownLogEventName(log: ParsedLogEntry): string {
  return (
    [log.eventPath, log.value].filter(Boolean).join(".") ||
    log.normalizedEventName?.trim() ||
    log.extracted?.trim() ||
    log.raw.trim() ||
    "unknown"
  );
}

function buildUnknownLiveResult(log: ParsedLogEntry): UnknownLiveResult | null {
  if (log.matchType !== "unknown" || log.matchedRowId !== null) {
    return null;
  }

  const eventName = getUnknownLogEventName(log);
  const normalizedEventName = normalizeValue(eventName) || "unknown";
  const reason = log.reason?.trim() || "No known event path";
  return {
    id: `unknown:${normalizedEventName}:${log.timestamp}:${log.id}`,
    logId: log.id,
    eventName,
    normalizedEventName,
    reason,
    analyticsType: log.analyticsType ?? null,
    analyticsSource: log.analyticsSource ?? null,
    timestamp: log.timestamp,
    lastSeenAt: log.timestamp,
    count: 1,
  };
}

function unknownLiveResultToTableRowModel(
  result: UnknownLiveResult,
): TableRowModel {
  return {
    id: result.id,
    dotStatus: "unknown",
    statusLabel: "unknown",
    event: result.eventName,
    value: null,
    analyticsType: result.analyticsType ?? result.analyticsSource ?? null,
    description:
      result.count > 1
        ? `${result.reason} (${result.count})`
        : result.reason,
  };
}

function doesUnknownResultMatchEventGroup(
  result: UnknownLiveResult,
  activeGroup: EventGroupTabId,
  platform: PlatformMode,
): boolean {
  if (activeGroup === "all") {
    return true;
  }
  if (platformUsesSdkEventGroupTabs(platform)) {
    if (!isUnityEventGroupTab(activeGroup)) {
      return true;
    }
    const type =
      getUnityAnalyticsTypeFromExplicitFields([
        result.analyticsType,
        result.analyticsSource,
      ]) ??
      inferUnityAnalyticsTypeFromText(
        [result.eventName, result.normalizedEventName, result.reason]
          .map(unknownToSearchText)
          .filter(Boolean)
          .join(" "),
      );
    return type === activeGroup;
  }
  if (!isAndroidEventGroupTab(activeGroup)) {
    return true;
  }
  return eventPathMatchesGroup(
    result.normalizedEventName,
    eventGroupPathByTab[activeGroup],
  );
}

function doesLogMatchSidebarFilter(
  log: ParsedLogEntry,
  filter: SidebarFilter,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "passed":
      return log.matchType === "passed";
    case "duplicate":
      return log.matchType === "duplicate";
    case "unknown":
      return log.matchType === "unknown";
    case "not_checked":
      return false;
    default:
      return true;
  }
}

function doesLogUpdateVisibleTableRow(
  log: ParsedLogEntry,
  filter: SidebarFilter,
): boolean {
  if (!log.matchedRowId) {
    return false;
  }
  switch (filter) {
    case "all":
      return true;
    case "passed":
      return log.matchType === "passed";
    case "duplicate":
      return log.matchType === "duplicate";
    case "unknown":
      return log.matchType === "unknown";
    case "not_checked":
      return false;
    default:
      return true;
  }
}

function sortLogsNewestFirst(logs: ParsedLogEntry[]): ParsedLogEntry[] {
  return logs
    .map((log, index) => ({ log, index }))
    .sort(
      (a, b) =>
        b.log.timestamp - a.log.timestamp ||
        b.index - a.index,
    )
    .map(({ log }) => log);
}

function matchTypeToDot(t: ParsedLogEntry["matchType"]): StatusDotVariant {
  switch (t) {
    case "passed":
      return "passed";
    case "duplicate":
      return "duplicate";
    case "partial":
      return "partial";
    case "unknown":
      return "unknown";
    default:
      return "unknown";
  }
}

function translateStatusLabel(label: string, labels: UiLabels): string {
  switch (label.toLowerCase()) {
    case "passed":
    case "matched":
      return labels.statuses.passed;
    case "partial":
      return labels.statuses.partial;
    case "duplicate":
      return labels.statuses.duplicate;
    case "unknown":
      return labels.statuses.unknown;
    case "not checked":
    case "not_checked":
      return labels.statuses.notChecked;
    default:
      return label;
  }
}

function setLatestRowUpdate(
  map: Map<string, number>,
  rowId: string,
  timestamp: number,
) {
  const current = map.get(rowId);
  if (current === undefined || timestamp > current) {
    map.set(rowId, timestamp);
  }
}

function orderRowsByLatestUpdate(
  rows: AnalyticsSpecRow[],
  latestUpdates: Map<string, number>,
): AnalyticsSpecRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const aTime = latestUpdates.get(a.row.id) ?? Number.NEGATIVE_INFINITY;
      const bTime = latestUpdates.get(b.row.id) ?? Number.NEGATIVE_INFINITY;
      return bTime - aTime || a.index - b.index;
    })
    .map(({ row }) => row);
}

function cloneSpecRowsForLiveUpdate(
  rows: AnalyticsSpecRow[],
): AnalyticsSpecRow[] {
  return rows.map((row) => ({
    ...row,
    cells: { ...row.cells },
    matchedLogIds: row.matchedLogIds ? [...row.matchedLogIds] : [],
    meta: row.meta ? { ...row.meta } : undefined,
  }));
}

function formatCoverageDebugList(values: string[]): string {
  return values.length > 0 ? values.join(",") : "[]";
}

async function clearAndroidBackendBuffer(context: string): Promise<void> {
  try {
    const res = await fetch("/api/android/clear", { method: "POST" });
    const data: { success?: boolean; error?: string } | null =
      await res.json().catch(() => null);
    if (!res.ok || data?.success === false) {
      console.warn(
        `[android-live] failed to clear backend buffer (${context})`,
        data?.error ?? res.statusText,
      );
    }
  } catch (e) {
    console.warn(`[android-live] failed to clear backend buffer (${context})`, e);
  }
}

async function stopAndroidBackend(context: string): Promise<void> {
  try {
    await fetch("/api/android/stop", { method: "POST" });
  } catch (e) {
    console.warn(`[android-live] failed to stop backend (${context})`, e);
  }
}

function isAndroidDeviceConnectionError(message: string): boolean {
  const normalized = message.toLowerCase();
  return [
    "no devices",
    "no device",
    "device not found",
    "no connected device",
    "no android device",
    "unauthorized",
    "offline",
    "adb devices",
  ].some((pattern) => normalized.includes(pattern));
}

function isAndroidPackageContextError(message: string): boolean {
  const normalized = message.toLowerCase();
  const mentionsPackage =
    normalized.includes("package") || normalized.includes("application id");
  if (!mentionsPackage) {
    return false;
  }

  return [
    "not found",
    "not installed",
    "does not exist",
    "unknown",
    "unable to find",
    "failed to resolve",
  ].some((pattern) => normalized.includes(pattern));
}

function androidStartErrorMessage(
  error: string | undefined,
  labels: UiLabels,
): string {
  const message = error?.trim();
  if (!message) {
    return labels.android.connectFailed;
  }

  if (isAndroidDeviceConnectionError(message)) {
    return labels.android.noDevice;
  }

  if (isAndroidPackageContextError(message)) {
    return labels.android.packageMismatch;
  }

  return message;
}

export default function Home() {
  const [importResult, setImportResult] = useState<ParsedSpecResult | null>(
    null,
  );
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isImportingGoogleSheet, setIsImportingGoogleSheet] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [googleSheetUrl, setGoogleSheetUrl] = useState("");
  const [googleSheetError, setGoogleSheetError] = useState<string | null>(null);
  const [lastXlsxImportDebugInfo, setLastXlsxImportDebugInfo] = useState<
    string | null
  >(null);
  const [googleSheetImportInfo, setGoogleSheetImportInfo] = useState<
    string | null
  >(null);
  const [googleSheetImportErrorDebug, setGoogleSheetImportErrorDebug] =
    useState<GoogleSheetImportErrorDebug | null>(null);
  const [googleSheetSourceUrl, setGoogleSheetSourceUrl] = useState<
    string | null
  >(null);
  const [googleSheetSyncMeta, setGoogleSheetSyncMeta] =
    useState<GoogleSheetSyncMetadata | null>(null);
  const [googleAuthStatus, setGoogleAuthStatus] = useState<GoogleAuthStatus>({
    configured: false,
    connected: false,
  });
  const [isGoogleConnecting, setIsGoogleConnecting] = useState(false);
  const [autoUpdateGoogleSheet, setAutoUpdateGoogleSheet] = useState(false);
  const [
    autoUpdateAttemptedWithoutRequirements,
    setAutoUpdateAttemptedWithoutRequirements,
  ] = useState(false);
  const [sheetSyncStatus, setSheetSyncStatus] =
    useState<SheetSyncStatus>("idle");
  const [sheetSyncError, setSheetSyncError] = useState<string | null>(null);
  const [pendingSheetUpdateCount, setPendingSheetUpdateCount] = useState(0);
  const [nextSheetSyncRetryAt, setNextSheetSyncRetryAt] = useState<
    number | null
  >(null);
  const [nextSheetSyncRetrySeconds, setNextSheetSyncRetrySeconds] = useState<
    number | null
  >(null);
  const [sheetSyncInFlight, setSheetSyncInFlight] = useState(false);
  const [sheetSyncStartedAt, setSheetSyncStartedAt] = useState<number | null>(
    null,
  );
  const [lastSheetSyncAttemptAt, setLastSheetSyncAttemptAt] = useState<
    number | null
  >(null);
  const [lastSheetSyncFinishedAt, setLastSheetSyncFinishedAt] = useState<
    number | null
  >(null);
  const [nextGoogleRowIndexRetryAt, setNextGoogleRowIndexRetryAt] = useState<
    number | null
  >(null);
  const [
    nextGoogleRowIndexRetrySeconds,
    setNextGoogleRowIndexRetrySeconds,
  ] = useState<number | null>(null);
  const [nextGoogleSheetImportRetryAt, setNextGoogleSheetImportRetryAt] =
    useState<number | null>(null);
  const [
    nextGoogleSheetImportRetrySeconds,
    setNextGoogleSheetImportRetrySeconds,
  ] = useState<number | null>(null);
  const [lastGoogleSheetSyncStatus, setLastGoogleSheetSyncStatus] = useState<
    "success" | "failed" | null
  >(null);
  const [lastGoogleSheetSyncUpdatedRows, setLastGoogleSheetSyncUpdatedRows] =
    useState<string[]>([]);
  const [lastGoogleSheetSyncRanges, setLastGoogleSheetSyncRanges] = useState<
    string[]
  >([]);
  const [lastGoogleSheetSyncApiStatus, setLastGoogleSheetSyncApiStatus] =
    useState<number | null>(null);
  const [
    lastGoogleSheetSyncTotalUpdatedCells,
    setLastGoogleSheetSyncTotalUpdatedCells,
  ] = useState<number | null>(null);
  const [
    lastGoogleSheetSyncTotalUpdatedRows,
    setLastGoogleSheetSyncTotalUpdatedRows,
  ] = useState<number | null>(null);
  const [
    isRetryingGoogleSheetCheckboxDetection,
    setIsRetryingGoogleSheetCheckboxDetection,
  ] = useState(false);
  const [manualCheckboxColumnInput, setManualCheckboxColumnInput] =
    useState(fixedGoogleSheetCheckboxColumnLetter);
  const [manualCheckboxColumnError, setManualCheckboxColumnError] =
    useState<string | null>(null);
  const [manualSheetTitleInput, setManualSheetTitleInput] = useState("");
  const [previewGoogleSheetWriteTargets, setPreviewGoogleSheetWriteTargets] =
    useState(false);
  const [googleSheetWriteTargetPreview, setGoogleSheetWriteTargetPreview] =
    useState<string[]>([]);
  const [
    skippedGoogleSheetWritebacks,
    setSkippedGoogleSheetWritebacks,
  ] = useState<SkippedGoogleSheetWriteback[]>([]);
  const [
    lastWritebackLookupFailure,
    setLastWritebackLookupFailure,
  ] = useState<GoogleSheetWritebackLookupFailure | null>(null);
  const [googleSheetRowIndex, setGoogleSheetRowIndex] =
    useState<GoogleSheetRowIndexState | null>(null);
  const [googleRowIndexStatus, setGoogleRowIndexStatus] =
    useState<GoogleRowIndexStatus>("idle");
  const [googleRowIndexLastError, setGoogleRowIndexLastError] =
    useState<string | null>(null);
  const [unknownLiveResults, setUnknownLiveResults] = useState<
    UnknownLiveResult[]
  >([]);
  const [isRebuildingGoogleRowIndex, setIsRebuildingGoogleRowIndex] =
    useState(false);
  const [, setGoogleSheetRowIndexError] =
    useState<string | null>(null);
  const [, setLastGoogleSheetTargetRange] =
    useState<string | null>(null);
  const [
    lastGoogleSheetMappingDebugInfo,
    setLastGoogleSheetMappingDebugInfo,
  ] = useState<string | null>(null);
  const [, setLastGoogleSheetTestWriteDebugInfo] = useState<string | null>(
    null,
  );
  const [logText, setLogText] = useState("");
  const [matchBundle, setMatchBundle] = useState<MatchBundleState | null>(null);
  const [processMessage, setProcessMessage] = useState<string | null>(null);
  const [activeSidebarFilter, setActiveSidebarFilter] =
    useState<SidebarFilter>("all");
  const [activeEventGroupTab, setActiveEventGroupTab] =
    useState<EventGroupTabId>("all");
  const [activePlatform, setActivePlatform] =
    useState<PlatformMode>("android");
  const [uiLanguage, setUiLanguage] = useState<UiLanguage>("en");
  const [uiLanguageLoaded, setUiLanguageLoaded] = useState(false);
  const [theme, setTheme] = useState<AppTheme>("dark");
  const [themeLoaded, setThemeLoaded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPopoverPosition, setSettingsPopoverPosition] =
    useState<SettingsPopoverPosition | null>(null);
  const [androidPackageName, setAndroidPackageName] = useState("");
  const [iosBundleId, setIosBundleId] = useState("");
  const [savedAndroidPackageNames, setSavedAndroidPackageNames] = useState<
    string[]
  >([]);
  const [isDetectingAndroidPackage, setIsDetectingAndroidPackage] =
    useState(false);
  const [androidPackageDetectError, setAndroidPackageDetectError] = useState<
    string | null
  >(null);
  const [androidLiveStatus, setAndroidLiveStatus] =
    useState<AndroidLiveStatus>("disconnected");
  const [androidLiveError, setAndroidLiveError] = useState<string | null>(null);
  const [androidSpecRequiredError, setAndroidSpecRequiredError] = useState<
    string | null
  >(null);
  const [liveFeedLines, setLiveFeedLines] = useState<
    { id: string; text: string }[]
  >([]);
  const [selectedLiveFeedLineId, setSelectedLiveFeedLineId] = useState<
    string | null
  >(null);
  const [highlightedMatchResultIds, setHighlightedMatchResultIds] = useState<
    string[]
  >([]);
  const [highlightedTableRowIds, setHighlightedTableRowIds] = useState<
    string[]
  >([]);
  const [recentResultsScrollSignal, setRecentResultsScrollSignal] =
    useState(0);
  const [tableScrollSignal, setTableScrollSignal] = useState(0);
  const [iosLiveStatus, setIosLiveStatus] =
    useState<AndroidLiveStatus>("disconnected");
  const [iosLiveError, setIosLiveError] = useState<string | null>(null);
  const [iosLiveFeedLines, setIosLiveFeedLines] = useState<
    { id: string; text: string }[]
  >([]);
  const [iosLunarConsoleInput, setIosLunarConsoleInput] = useState("");
  const [iosLunarRawPreviewLines, setIosLunarRawPreviewLines] = useState<
    string[]
  >([]);
  const [iosLunarRawLinesCount, setIosLunarRawLinesCount] = useState(0);
  const [iosLunarAnalyticsCandidateLinesCount, setIosLunarAnalyticsCandidateLinesCount] =
    useState(0);
  const [iosLunarLastRawLine, setIosLunarLastRawLine] = useState<string | null>(
    null,
  );
  const [iosLunarLastExtractedEvent, setIosLunarLastExtractedEvent] = useState<
    string | null
  >(null);
  const [
    iosLunarLastExtractedAnalyticsType,
    setIosLunarLastExtractedAnalyticsType,
  ] = useState<"AppsFlyer" | "AppMetrica" | "ABTest" | null>(null);
  const [iosLunarImportSource, setIosLunarImportSource] = useState<
    "paste" | "file" | null
  >(null);
  const [isProcessingIosLunarConsole, setIsProcessingIosLunarConsole] =
    useState(false);
  const [unityLogPath, setUnityLogPath] = useState("");
  const [unityLiveStatus, setUnityLiveStatus] =
    useState<AndroidLiveStatus>("disconnected");
  const [unityLiveError, setUnityLiveError] = useState<string | null>(null);
  const [unityLiveFeedLines, setUnityLiveFeedLines] = useState<
    UnityLiveFeedLine[]
  >([]);
  const [unityShowAllLogLines, setUnityShowAllLogLines] = useState(true);
  const [selectedUnityLiveFeedLineId, setSelectedUnityLiveFeedLineId] =
    useState<string | null>(null);
  const [unityManualEventInput, setUnityManualEventInput] = useState("");
  const [isProcessingUnityManualEvent, setIsProcessingUnityManualEvent] =
    useState(false);
  const [unityResolvedLogPath, setUnityResolvedLogPath] =
    useState<string | null>(null);
  const [unityLogFileName, setUnityLogFileName] =
    useState<string | null>(null);
  const [unityLogSourceType, setUnityLogSourceType] = useState<
    "editor" | "player" | "custom"
  >("custom");
  const [unityDetectedProjectPath, setUnityDetectedProjectPath] =
    useState<string | null>(null);
  const [unityDetectedProductName, setUnityDetectedProductName] =
    useState<string | null>(null);
  const [unityLogFileExists, setUnityLogFileExists] =
    useState<boolean | null>(null);
  const [unityWatcherStarted, setUnityWatcherStarted] = useState(false);
  const [unityLastError, setUnityLastError] = useState<string | null>(null);
  const [unityLastLineAt, setUnityLastLineAt] = useState<number | null>(null);
  const [unityAnalyticsEventsSeenCount, setUnityAnalyticsEventsSeenCount] =
    useState(0);
  const [unityRawLinesSeenCount, setUnityRawLinesSeenCount] = useState(0);
  const [
    unityAnalyticsCandidateLinesCount,
    setUnityAnalyticsCandidateLinesCount,
  ] = useState(0);
  const [unityLastRawLineAt, setUnityLastRawLineAt] =
    useState<number | null>(null);
  const [unityInitialTailRead, setUnityInitialTailRead] = useState(false);
  const [unityInitialTailLinesCount, setUnityInitialTailLinesCount] =
    useState(0);
  const [unityLastRawLine, setUnityLastRawLine] = useState<string | null>(null);
  const [unityLastExtractedEvent, setUnityLastExtractedEvent] =
    useState<string | null>(null);
  const [
    unityLastExtractedAnalyticsType,
    setUnityLastExtractedAnalyticsType,
  ] = useState<"AppsFlyer" | "AppMetrica" | "ABTest" | null>(null);
  const [unityTailMode, setUnityTailMode] = useState<
    "watcher" | "polling" | "both" | null
  >(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  const iosEventSourceRef = useRef<EventSource | null>(null);
  const unityEventSourceRef = useRef<EventSource | null>(null);
  const unityConnectTimeoutRef = useRef<number | null>(null);
  const unityConnectRequestSeqRef = useRef(0);
  const liveFeedScrollRef = useRef<HTMLElement | null>(null);
  const recentResultsRef = useRef<HTMLUListElement | null>(null);
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const settingsPopoverRef = useRef<HTMLDivElement | null>(null);
  const activePlatformRef = useRef<PlatformMode>("android");
  const platformWorkspacesRef =
    useRef<Record<PlatformMode, PlatformWorkspaceState>>(
      createDefaultPlatformWorkspaces(),
    );
  const importResultRef = useRef(importResult);
  const originalWorkbookBufferRef = useRef<ArrayBuffer | null>(null);
  const androidLiveContextRef = useRef(0);
  const knownMatchResultIdsRef = useRef<Set<string>>(new Set());
  const highlightTimeoutsRef = useRef<Map<string, number>>(new Map());
  const knownTableLogIdsRef = useRef<Set<string>>(new Set());
  const tableHighlightTimeoutsRef = useRef<Map<string, number>>(new Map());
  const liveDuplicateSeenByEventNameRef = useRef<
    Map<string, LiveDuplicateSeen>
  >(new Map());
  const googleSheetSyncMetaRef = useRef<GoogleSheetSyncMetadata | null>(null);
  const unknownLiveResultsRef = useRef<UnknownLiveResult[]>([]);
  const unknownLiveLogIdsRef = useRef<Set<string>>(new Set());
  const manualCheckboxColumnInputRef = useRef(
    fixedGoogleSheetCheckboxColumnLetter,
  );
  const manualGoogleSheetSyncSettingsRef =
    useRef<ManualGoogleSheetSyncSettings>({
      tabKey: null,
      manualSheetTitle: null,
      sheetTitleSource: null,
      manualCheckboxColumnInput: fixedGoogleSheetCheckboxColumnLetter,
      checkboxColumnSource: "fixed",
    });
  const googleAuthConnectedRef = useRef(false);
  const autoUpdateGoogleSheetRef = useRef(false);
  const previewGoogleSheetWriteTargetsRef = useRef(false);
  const googleSheetRowIndexRef = useRef<GoogleSheetRowIndexState | null>(null);
  const pendingSheetUpdatesRef = useRef<Map<string, PendingGoogleSheetUpdate>>(
    new Map(),
  );
  const skippedGoogleSheetWritebacksRef = useRef<
    Map<string, SkippedGoogleSheetWriteback>
  >(new Map());
  const lastWritebackLookupFailureRef =
    useRef<GoogleSheetWritebackLookupFailure | null>(null);
  const syncedGoogleSheetRowIdsRef = useRef<Set<string>>(new Set());
  const sheetSyncSeenLogIdsRef = useRef<Set<string>>(new Set());
  const sheetSyncTimerRef = useRef<number | null>(null);
  const sheetSyncScheduledAtRef = useRef<number | null>(null);
  const sheetSyncRetryAttemptRef = useRef(0);
  const isSheetSyncFlushingRef = useRef(false);
  const sheetSyncStartedAtRef = useRef<number | null>(null);
  const lastSheetSyncAttemptAtRef = useRef<number | null>(null);
  const lastSheetSyncFinishedAtRef = useRef<number | null>(null);
  const googleSheetRowIndexNetworkIssueRef = useRef(false);
  const googleSheetRowIndexRetryAttemptRef = useRef(0);
  const googleRowIndexStatusRef = useRef<GoogleRowIndexStatus>("idle");
  const googleRowIndexLastErrorRef = useRef<string | null>(null);
  const isGoogleSheetRowIndexRebuildingRef = useRef(false);
  const googleSheetTitleRetryTimerRef = useRef<number | null>(null);
  const googleSheetTitleRetryAttemptRef = useRef(0);
  const googleSheetSyncMappingIssueRef = useRef(false);
  const googleSheetRowIndexRetryTimerRef = useRef<number | null>(null);
  const googleSheetImportRetryTimerRef = useRef<number | null>(null);
  const googleSheetImportRequestSeqRef = useRef(0);
  const activeGoogleSheetImportRequestRef =
    useRef<GoogleSheetImportClientRequest | null>(null);
  const flushSheetSyncQueueRef = useRef<
    ((reason?: "auto" | "manual") => Promise<void>) | null
  >(null);
  const scheduleNextGoogleSheetFlushBecausePendingRef = useRef<
    ((
      delayMs?: number,
      options?: { replaceExisting?: boolean; showRetryCountdown?: boolean },
    ) => boolean) | null
  >(null);
  const sheetTitleResolveKeyRef = useRef<string | null>(null);
  const googleAuthPollTimerRef = useRef<number | null>(null);
  const isImportingRef = useRef(false);
  const isImportingGoogleSheetRef = useRef(false);
  const labels = uiLabels[uiLanguage];
  activePlatformRef.current = activePlatform;
  importResultRef.current = importResult;
  googleSheetSyncMetaRef.current = googleSheetSyncMeta;
  manualCheckboxColumnInputRef.current = manualCheckboxColumnInput;
  isImportingRef.current = isImporting;
  isImportingGoogleSheetRef.current = isImportingGoogleSheet;
  googleAuthConnectedRef.current = googleAuthStatus.connected;
  autoUpdateGoogleSheetRef.current = autoUpdateGoogleSheet;
  previewGoogleSheetWriteTargetsRef.current = previewGoogleSheetWriteTargets;
  googleSheetRowIndexRef.current = googleSheetRowIndex;
  googleRowIndexStatusRef.current = googleRowIndexStatus;
  googleRowIndexLastErrorRef.current = googleRowIndexLastError;
  unknownLiveResultsRef.current = unknownLiveResults;

  const eventGroupTabsForCurrentPlatform: Array<{
    id: EventGroupTabId;
    label: string;
  }> = platformUsesSdkEventGroupTabs(activePlatform)
    ? unityEventGroupTabIds.map((id) => ({
        id,
        label: labels.unityEventGroupLabels[id],
      }))
    : androidEventGroupTabs;

  useEffect(() => {
    if (!isEventGroupTabAvailableForPlatform(activeEventGroupTab, activePlatform)) {
      setActiveEventGroupTab("all");
    }
  }, [activeEventGroupTab, activePlatform]);

  const syncSkippedGoogleSheetWritebacksState = useCallback(() => {
    setSkippedGoogleSheetWritebacks(
      [...skippedGoogleSheetWritebacksRef.current.values()].sort(
        (a, b) => b.skippedAt - a.skippedAt,
      ),
    );
  }, []);

  const recordGoogleSheetWritebackLookupFailure = useCallback(
    (params: {
      update: PendingGoogleSheetUpdate;
      target: GoogleSheetRowIndexWriteTarget;
      matchedRowId?: string | null;
    }): GoogleSheetWritebackLookupFailure => {
      const reason =
        params.target.candidates && params.target.reason
          ? `${params.target.reason}; candidates=${params.target.candidates}`
          : params.target.reason ?? "No matching Google Sheet event row";
      const normalizedEventName = normalizeGoogleSheetEventName(
        params.update.eventName,
      );
      const failure: GoogleSheetWritebackLookupFailure = {
        eventName: params.update.eventName,
        normalizedEventName,
        rowId: params.update.rowId,
        matchedRowId: params.matchedRowId ?? params.update.rowId,
        pendingUpdate: { ...params.update },
        rowIndexStatus: googleRowIndexStatusRef.current,
        rowIndexMappedEventsCount:
          googleSheetRowIndexRef.current?.indexedEventCount ?? 0,
        candidates: params.target.candidates || "none",
        reason,
        occurredAt: Date.now(),
      };
      lastWritebackLookupFailureRef.current = failure;
      setLastWritebackLookupFailure(failure);
      console.warn("[googleSheetWritebackLookup] failed");
      console.warn(`eventName=${failure.eventName}`);
      console.warn(`normalizedEventName=${failure.normalizedEventName}`);
      console.warn(`rowId=${failure.rowId}`);
      console.warn(`matchedRowId=${failure.matchedRowId ?? "null"}`);
      console.warn(`pendingUpdate=${JSON.stringify(failure.pendingUpdate)}`);
      console.warn(`rowIndexStatus=${failure.rowIndexStatus}`);
      console.warn(
        `rowIndexMappedEventsCount=${failure.rowIndexMappedEventsCount}`,
      );
      console.warn(`candidates=${failure.candidates}`);
      console.warn(`reason=${failure.reason}`);
      return failure;
    },
    [],
  );

  const rememberSkippedGoogleSheetWriteback = useCallback(
    (failure: GoogleSheetWritebackLookupFailure) => {
      skippedGoogleSheetWritebacksRef.current.set(failure.rowId, {
        rowId: failure.rowId,
        eventName: failure.eventName,
        normalizedEventName: failure.normalizedEventName,
        reason: failure.reason,
        candidates: failure.candidates,
        skippedAt: Date.now(),
      });
      syncSkippedGoogleSheetWritebacksState();
    },
    [syncSkippedGoogleSheetWritebacksState],
  );

  const forgetSkippedGoogleSheetWriteback = useCallback(
    (rowId: string) => {
      if (!skippedGoogleSheetWritebacksRef.current.delete(rowId)) {
        return;
      }
      syncSkippedGoogleSheetWritebacksState();
    },
    [syncSkippedGoogleSheetWritebacksState],
  );

  const requeueResolvedSkippedGoogleSheetWritebacks = useCallback(
    (rowIndex: GoogleSheetRowIndexState): number => {
      let requeuedCount = 0;
      for (const skipped of [
        ...skippedGoogleSheetWritebacksRef.current.values(),
      ]) {
        const target = resolveGoogleSheetImportStaircaseWriteTarget(
          {
            rowId: skipped.rowId,
            matchedRowId: skipped.rowId,
            eventName: skipped.eventName,
            status: "passed",
          },
          {
            writeSheetTitle: rowIndex.sheetTitle,
            rowIndex,
          },
        );
        if (target.reason !== null || target.rowNumber === null) {
          continue;
        }
        pendingSheetUpdatesRef.current.set(skipped.rowId, {
          rowId: skipped.rowId,
          matchedRowId: skipped.rowId,
          eventName: skipped.eventName,
          status: "passed",
          sourceRowNumber: target.rowNumber,
          range: target.range,
          source: target.source ?? rowIndex.source,
        });
        skippedGoogleSheetWritebacksRef.current.delete(skipped.rowId);
        requeuedCount += 1;
      }
      if (requeuedCount > 0) {
        setPendingSheetUpdateCount(pendingSheetUpdatesRef.current.size);
        syncSkippedGoogleSheetWritebacksState();
        console.log(
          `[googleSheetWritebackLookup] requeuedAfterRebuild count=${requeuedCount}`,
        );
      }
      return requeuedCount;
    },
    [syncSkippedGoogleSheetWritebacksState],
  );

  const getOrBuildGoogleSheetImportStaircaseIndex = useCallback(
    (meta: GoogleSheetSyncMetadata | null): GoogleSheetRowIndexState | null => {
      const current = googleSheetRowIndexRef.current;
      if (isGoogleSheetRowIndexReadyForMeta(current, meta)) {
        return current;
      }
      const nextIndex = buildGoogleSheetRowIndexFromSourceMetadata(meta);
      if (!nextIndex) {
        return null;
      }
      setGoogleSheetRowIndex(nextIndex);
      googleSheetRowIndexRef.current = nextIndex;
      setGoogleRowIndexStatus("ready");
      googleRowIndexStatusRef.current = "ready";
      setGoogleRowIndexLastError(null);
      googleRowIndexLastErrorRef.current = null;
      setGoogleSheetRowIndexError(null);
      console.log(
        `[googleSheetWritebackIndex] ${nextIndex.source ?? "googleSheetImportStaircaseIndex"} built mappedEvents=${nextIndex.indexedEventCount}`,
      );
      return nextIndex;
    },
    [],
  );

  useEffect(() => {
    if (nextSheetSyncRetryAt === null) {
      setNextSheetSyncRetrySeconds(null);
      return;
    }

    const updateRetrySeconds = () => {
      setNextSheetSyncRetrySeconds(
        Math.max(1, Math.ceil((nextSheetSyncRetryAt - Date.now()) / 1000)),
      );
    };

    updateRetrySeconds();
    const intervalId = window.setInterval(updateRetrySeconds, 1000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [nextSheetSyncRetryAt]);

  useEffect(() => {
    if (nextGoogleRowIndexRetryAt === null) {
      setNextGoogleRowIndexRetrySeconds(null);
      return;
    }

    const updateRetrySeconds = () => {
      setNextGoogleRowIndexRetrySeconds(
        Math.max(
          1,
          Math.ceil((nextGoogleRowIndexRetryAt - Date.now()) / 1000),
        ),
      );
    };

    updateRetrySeconds();
    const intervalId = window.setInterval(updateRetrySeconds, 1000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [nextGoogleRowIndexRetryAt]);

  useEffect(() => {
    if (nextGoogleSheetImportRetryAt === null) {
      setNextGoogleSheetImportRetrySeconds(null);
      return;
    }

    const updateRetrySeconds = () => {
      setNextGoogleSheetImportRetrySeconds(
        Math.max(
          1,
          Math.ceil((nextGoogleSheetImportRetryAt - Date.now()) / 1000),
        ),
      );
    };

    updateRetrySeconds();
    const intervalId = window.setInterval(updateRetrySeconds, 1000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [nextGoogleSheetImportRetryAt]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(uiLanguageStorageKey);
      if (stored === "en" || stored === "ru") {
        setUiLanguage(stored);
      }
    } catch (e) {
      console.warn("[ui-language] failed to load saved language", e);
    } finally {
      setUiLanguageLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!uiLanguageLoaded) {
      return;
    }
    try {
      window.localStorage.setItem(uiLanguageStorageKey, uiLanguage);
    } catch (e) {
      console.warn("[ui-language] failed to save language", e);
    }
  }, [uiLanguage, uiLanguageLoaded]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(themeStorageKey);
      if (stored === "dark" || stored === "light") {
        setTheme(stored);
      }
    } catch (e) {
      console.warn("[theme] failed to load saved theme", e);
    } finally {
      setThemeLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!themeLoaded) {
      return;
    }
    try {
      window.localStorage.setItem(themeStorageKey, theme);
    } catch (e) {
      console.warn("[theme] failed to save theme", e);
    }
  }, [theme, themeLoaded]);

  useEffect(() => {
    setManualCheckboxColumnError(
      manualCheckboxColumnInput.trim() &&
        a1ColumnToIndex(manualCheckboxColumnInput) === null
        ? labels.google.invalidColumnLetter
        : null,
    );
  }, [labels.google, manualCheckboxColumnInput]);

  const refreshGoogleAuthStatus = useCallback(
    async (): Promise<GoogleAuthStatus> => {
      try {
        const response = await fetch("/api/google/auth/status");
        const payload = (await response.json().catch(() => null)) as
          | (GoogleAuthStatus & { success?: boolean })
          | null;
        const status = {
          configured: Boolean(payload?.configured),
          connected: Boolean(payload?.connected),
        };
        setGoogleAuthStatus(status);
        googleAuthConnectedRef.current = status.connected;
        if (status.connected) {
          setSheetSyncError((current) =>
            current === googleAuthPendingMessage ||
            current === labels.google.authPending
              ? null
              : current,
          );
        }
        return status;
      } catch (e) {
        console.warn("[google-auth] failed to load status", e);
        const status = { configured: false, connected: false };
        setGoogleAuthStatus(status);
        googleAuthConnectedRef.current = false;
        return status;
      }
    },
    [labels.google],
  );

  useEffect(() => {
    void refreshGoogleAuthStatus();
    const handleFocus = () => {
      void refreshGoogleAuthStatus();
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [refreshGoogleAuthStatus]);

  const stopGoogleAuthStatusPolling = useCallback(() => {
    if (googleAuthPollTimerRef.current !== null) {
      window.clearTimeout(googleAuthPollTimerRef.current);
      googleAuthPollTimerRef.current = null;
    }
  }, []);

  const startGoogleAuthStatusPolling = useCallback(() => {
    stopGoogleAuthStatusPolling();
    const startedAt = Date.now();

    const poll = async () => {
      const status = await refreshGoogleAuthStatus();
      if (status.connected) {
        stopGoogleAuthStatusPolling();
        setIsGoogleConnecting(false);
        setSheetSyncError((current) =>
          current === googleAuthPendingMessage ||
          current === labels.google.authPending
            ? null
            : current,
        );
        return;
      }

      if (Date.now() - startedAt >= googleAuthPollingTimeoutMs) {
        stopGoogleAuthStatusPolling();
        setIsGoogleConnecting(false);
        console.warn(
          "[googleAuth] callback success but status is not connected",
        );
        return;
      }

      googleAuthPollTimerRef.current = window.setTimeout(
        () => void poll(),
        googleAuthPollingIntervalMs,
      );
    };

    void poll();
  }, [labels.google, refreshGoogleAuthStatus, stopGoogleAuthStatusPolling]);

  useEffect(() => {
    return () => {
      stopGoogleAuthStatusPolling();
    };
  }, [stopGoogleAuthStatusPolling]);

  const handleGoogleConnect = useCallback(async () => {
    setIsGoogleConnecting(true);
    setSheetSyncError(null);
    try {
      const response = await fetch("/api/google/auth/start", {
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as
        | {
            success?: boolean;
            authUrl?: string;
            redirectUri?: string;
            debug?: { redirectUri?: string };
            error?: string;
          }
        | null;
      const redirectUri =
        payload?.redirectUri ?? payload?.debug?.redirectUri ?? "<not returned>";
      console.log(`[googleOAuth] redirect_uri=${redirectUri}`);
      if (!response.ok || !payload?.success || !payload.authUrl) {
        throw new Error(payload?.error ?? labels.google.sheetSyncFailed);
      }

      window.open(payload.authUrl, "_blank", "noopener,noreferrer");
      setSheetSyncStatus(
        pendingSheetUpdatesRef.current.size > 0 ? "pending" : "idle",
      );
      setSheetSyncError(labels.google.authPending);
      startGoogleAuthStatusPolling();
    } catch (e) {
      setSheetSyncStatus("failed");
      setSheetSyncError(e instanceof Error ? e.message : labels.google.sheetSyncFailed);
      setIsGoogleConnecting(false);
    }
  }, [labels.google, startGoogleAuthStatusPolling]);

  const handleGoogleReconnect = useCallback(async () => {
    setIsGoogleConnecting(true);
    setSheetSyncError(null);
    try {
      const response = await fetch("/api/google/auth/disconnect", {
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as
        | { success?: boolean; error?: string }
        | null;
      if (!response.ok || !payload?.success) {
        throw new Error(payload?.error ?? labels.google.sheetSyncFailed);
      }
      const status = {
        configured: googleAuthStatus.configured,
        connected: false,
      };
      setGoogleAuthStatus(status);
      googleAuthConnectedRef.current = false;
      await handleGoogleConnect();
    } catch (e) {
      setSheetSyncStatus("failed");
      setSheetSyncError(
        e instanceof Error ? e.message : labels.google.sheetSyncFailed,
      );
      setIsGoogleConnecting(false);
    }
  }, [googleAuthStatus.configured, handleGoogleConnect, labels.google]);

  const clearScheduledGoogleRowIndexRebuild = useCallback(() => {
    if (googleSheetRowIndexRetryTimerRef.current !== null) {
      window.clearTimeout(googleSheetRowIndexRetryTimerRef.current);
      googleSheetRowIndexRetryTimerRef.current = null;
    }
    setNextGoogleRowIndexRetryAt(null);
    setNextGoogleRowIndexRetrySeconds(null);
  }, []);

  const clearScheduledGoogleSheetTitleResolve = useCallback(() => {
    if (googleSheetTitleRetryTimerRef.current !== null) {
      window.clearTimeout(googleSheetTitleRetryTimerRef.current);
      googleSheetTitleRetryTimerRef.current = null;
    }
  }, []);

  const clearGoogleSheetSyncQueue = useCallback(() => {
    if (sheetSyncTimerRef.current !== null) {
      window.clearTimeout(sheetSyncTimerRef.current);
      sheetSyncTimerRef.current = null;
    }
    clearScheduledGoogleRowIndexRebuild();
    clearScheduledGoogleSheetTitleResolve();
    setNextSheetSyncRetryAt(null);
    setNextSheetSyncRetrySeconds(null);
    pendingSheetUpdatesRef.current.clear();
    skippedGoogleSheetWritebacksRef.current.clear();
    syncedGoogleSheetRowIdsRef.current.clear();
    sheetSyncSeenLogIdsRef.current.clear();
    lastWritebackLookupFailureRef.current = null;
    isSheetSyncFlushingRef.current = false;
    sheetSyncStartedAtRef.current = null;
    lastSheetSyncAttemptAtRef.current = null;
    lastSheetSyncFinishedAtRef.current = null;
    setSheetSyncInFlight(false);
    setSheetSyncStartedAt(null);
    setLastSheetSyncAttemptAt(null);
    setLastSheetSyncFinishedAt(null);
    sheetSyncRetryAttemptRef.current = 0;
    googleSheetRowIndexRetryAttemptRef.current = 0;
    googleSheetTitleRetryAttemptRef.current = 0;
    googleSheetRowIndexNetworkIssueRef.current = false;
    googleSheetSyncMappingIssueRef.current = false;
    setPendingSheetUpdateCount(0);
    setSkippedGoogleSheetWritebacks([]);
    setLastWritebackLookupFailure(null);
    setSheetSyncStatus("idle");
    setSheetSyncError(null);
    setLastGoogleSheetSyncStatus(null);
    setLastGoogleSheetSyncUpdatedRows([]);
    setLastGoogleSheetSyncRanges([]);
    setLastGoogleSheetSyncApiStatus(null);
    setLastGoogleSheetSyncTotalUpdatedCells(null);
    setLastGoogleSheetSyncTotalUpdatedRows(null);
    setLastGoogleSheetMappingDebugInfo(null);
    setLastGoogleSheetTargetRange(null);
    setGoogleSheetWriteTargetPreview([]);
  }, [
    clearScheduledGoogleRowIndexRebuild,
    clearScheduledGoogleSheetTitleResolve,
  ]);

  const clearGoogleSheetSyncErrorState = useCallback(() => {
    setSheetSyncError(null);
    setLastGoogleSheetSyncStatus((current) =>
      current === "failed" ? null : current,
    );
    setLastGoogleSheetSyncUpdatedRows([]);
    if (pendingSheetUpdatesRef.current.size === 0) {
      setPendingSheetUpdateCount(0);
      setSheetSyncStatus((current) =>
        current === "failed" || current === "pending" ? "idle" : current,
      );
    }
  }, []);

  const rememberManualGoogleSheetSyncSettings = useCallback(
    (settings: Partial<Omit<ManualGoogleSheetSyncSettings, "tabKey">>) => {
      const tabKey =
        getGoogleSheetTabKey(googleSheetSyncMetaRef.current) ??
        manualGoogleSheetSyncSettingsRef.current.tabKey;
      if (tabKey === null) {
        return;
      }
      manualGoogleSheetSyncSettingsRef.current = {
        ...manualGoogleSheetSyncSettingsRef.current,
        ...settings,
        tabKey,
      };
    },
    [],
  );

  const resetManualGoogleSheetSyncSettings = useCallback(() => {
    clearScheduledGoogleRowIndexRebuild();
    clearScheduledGoogleSheetTitleResolve();
    googleSheetRowIndexRetryAttemptRef.current = 0;
    googleSheetTitleRetryAttemptRef.current = 0;
    googleSheetRowIndexNetworkIssueRef.current = false;
    manualGoogleSheetSyncSettingsRef.current = {
      tabKey: null,
      manualSheetTitle: null,
      sheetTitleSource: null,
      manualCheckboxColumnInput: fixedGoogleSheetCheckboxColumnLetter,
      checkboxColumnSource: "fixed",
    };
    setManualCheckboxColumnInput(fixedGoogleSheetCheckboxColumnLetter);
    manualCheckboxColumnInputRef.current = fixedGoogleSheetCheckboxColumnLetter;
    setManualCheckboxColumnError(null);
    setManualSheetTitleInput("");
    setGoogleSheetRowIndex(null);
    googleSheetRowIndexRef.current = null;
    setGoogleRowIndexStatus("idle");
    googleRowIndexStatusRef.current = "idle";
    setGoogleRowIndexLastError(null);
    googleRowIndexLastErrorRef.current = null;
    setGoogleSheetRowIndexError(null);
    setGoogleSheetSyncMeta((current) => {
      const nextMeta = current
        ? withoutManualGoogleSheetSettings(current)
        : current;
      googleSheetSyncMetaRef.current = nextMeta;
      return nextMeta;
    });
  }, [
    clearScheduledGoogleRowIndexRebuild,
    clearScheduledGoogleSheetTitleResolve,
  ]);

  const handleGoogleSheetUrlChange = useCallback(
    (value: string) => {
      const previousTabKey =
        getGoogleSheetTabKey(googleSheetSyncMetaRef.current) ??
        manualGoogleSheetSyncSettingsRef.current.tabKey;
      const nextUrlParts = parseGoogleSheetUrlForWriteback(value);
      const nextTabKey = nextUrlParts ? getGoogleSheetTabKey(nextUrlParts) : null;
      setGoogleSheetUrl(value);
      setGoogleSheetImportInfo(null);
      setAutoUpdateAttemptedWithoutRequirements(false);
      if (
        nextTabKey !== null &&
        previousTabKey !== null &&
        nextTabKey !== previousTabKey
      ) {
        setManualSheetTitleInput("");
        manualGoogleSheetSyncSettingsRef.current = {
          ...manualGoogleSheetSyncSettingsRef.current,
          tabKey: nextTabKey,
          manualSheetTitle: null,
          sheetTitleSource: null,
        };
        sheetTitleResolveKeyRef.current = null;
        setLastGoogleSheetMappingDebugInfo((current) =>
          [
            `Google Sheet URL changed; cleared stale sheet title for ${nextTabKey}`,
            ...(current?.split("\n") ?? []),
          ]
            .slice(0, 5)
            .join("\n"),
        );
      }
      if (value.trim().length === 0) {
        resetManualGoogleSheetSyncSettings();
      }
    },
    [resetManualGoogleSheetSyncSettings],
  );

  const rebuildGoogleSheetRowIndex = useCallback(async (
    force = false,
    options: GoogleSheetRowIndexRebuildOptions = {},
  ) => {
    const meta = googleSheetSyncMetaRef.current;
    const writeSheetTitle = getGoogleSheetWriteSheetTitle(meta);
    if (!meta || writeSheetTitle === null) {
      setGoogleSheetRowIndexError(labels.google.sheetTabNameRequired);
      setGoogleRowIndexStatus("failed");
      googleRowIndexStatusRef.current = "failed";
      setGoogleRowIndexLastError(labels.google.sheetTabNameRequired);
      googleRowIndexLastErrorRef.current = labels.google.sheetTabNameRequired;
      console.log(
        `[googleRowIndex] rebuildFailed error=${labels.google.sheetTabNameRequired}`,
      );
      return null;
    }
    if (isUnityStaircaseGoogleSheetMeta(meta)) {
      console.log("[googleRowIndex] rebuild requested");
      console.log("[googleRowIndex] cacheVersion=v4");
      console.log(
        `[googleRowIndex] unity rebuild from import rows range=${getGoogleSheetRowIndexReadRange(
          meta,
          writeSheetTitle,
        )}`,
      );
      console.log(
        `[googleRowIndex] unity sourceRows=${meta.rows.length} staircaseRows=${
          meta.staircaseRows?.length ?? 0
        }`,
      );
      const rowIndexBuildStartedAt = Date.now();
      setGoogleRowIndexStatus("building");
      googleRowIndexStatusRef.current = "building";
      setGoogleRowIndexLastError(null);
      googleRowIndexLastErrorRef.current = null;
      setGoogleSheetRowIndexError(null);
      const nextIndex = buildGoogleSheetRowIndexFromSourceMetadata(meta);
      if (!nextIndex) {
        const message = labels.google.missingSourceRowMapping;
        setGoogleSheetRowIndex(null);
        googleSheetRowIndexRef.current = null;
        setGoogleRowIndexStatus("failed");
        googleRowIndexStatusRef.current = "failed";
        setGoogleRowIndexLastError(message);
        googleRowIndexLastErrorRef.current = message;
        setGoogleSheetRowIndexError(message);
        setSheetSyncStatus("failed");
        setSheetSyncError(`${labels.google.rowIndexFailed}: ${message}`);
        console.log(`[googleRowIndex] rebuildFailed error=${message}`);
        return null;
      }
      setGoogleSheetRowIndex(nextIndex);
      googleSheetRowIndexRef.current = nextIndex;
      setGoogleRowIndexStatus("ready");
      googleRowIndexStatusRef.current = "ready";
      setGoogleRowIndexLastError(null);
      googleRowIndexLastErrorRef.current = null;
      googleSheetRowIndexNetworkIssueRef.current = false;
      googleSheetSyncMappingIssueRef.current = false;
      googleSheetRowIndexRetryAttemptRef.current = 0;
      clearScheduledGoogleRowIndexRebuild();
      setGoogleSheetRowIndexError(null);
      const requeuedSkippedCount =
        requeueResolvedSkippedGoogleSheetWritebacks(nextIndex);
      if (pendingSheetUpdatesRef.current.size === 0) {
        setSheetSyncStatus("idle");
        setSheetSyncError(labels.google.syncReady);
      }
      console.log(`[googleRowIndex] rows=${nextIndex.rowCount}`);
      console.log(`[googleRowIndex] mappedEvents=${nextIndex.indexedEventCount}`);
      console.log(
        `[googleRowIndex] build success durationMs=${
          Date.now() - rowIndexBuildStartedAt
        }`,
      );
      console.log(
        `[googleRowIndex] rebuildSuccess sheetTitle=${nextIndex.sheetTitle} rowsRead=${nextIndex.rowCount} indexSize=${nextIndex.indexedEventCount}`,
      );
      console.log(`[googleRowIndex] requeuedSkipped=${requeuedSkippedCount}`);
      logGoogleSheetRowIndexDiagnostics(nextIndex);
      const shouldScheduleSync =
        options.scheduleSyncAfter !== false &&
        nextIndex.indexedEventCount > 0 &&
        pendingSheetUpdatesRef.current.size > 0 &&
        autoUpdateGoogleSheetRef.current &&
        googleAuthConnectedRef.current &&
        !isSheetSyncFlushingRef.current;
      if (shouldScheduleSync) {
        scheduleNextGoogleSheetFlushBecausePendingRef.current?.(0, {
          replaceExisting: true,
        });
      }
      return nextIndex;
    }
    if (!googleAuthConnectedRef.current) {
      setGoogleSheetRowIndexError(labels.google.googleNotConnected);
      setGoogleRowIndexStatus("failed");
      googleRowIndexStatusRef.current = "failed";
      setGoogleRowIndexLastError(labels.google.googleNotConnected);
      googleRowIndexLastErrorRef.current = labels.google.googleNotConnected;
      console.log(
        `[googleRowIndex] rebuildFailed error=${labels.google.googleNotConnected}`,
      );
      return null;
    }
    if (options.resetRetryAttempt) {
      googleSheetRowIndexRetryAttemptRef.current = 0;
    }
    console.log("[googleRowIndex] rebuild requested");
    console.log("[googleRowIndex] cacheVersion=v4");
    if (isGoogleSheetRowIndexRebuildingRef.current) {
      console.log("[googleRowIndex] skipped because inFlight=true");
      const current = googleSheetRowIndexRef.current;
      return isGoogleSheetRowIndexReadyForMeta(current, meta) ? current : null;
    }

    clearScheduledGoogleRowIndexRebuild();
    isGoogleSheetRowIndexRebuildingRef.current = true;
    setIsRebuildingGoogleRowIndex(true);
    setGoogleRowIndexStatus("building");
    googleRowIndexStatusRef.current = "building";
    setGoogleRowIndexLastError(null);
    googleRowIndexLastErrorRef.current = null;
    setGoogleSheetRowIndexError(null);
    setSheetSyncError(labels.google.preparingSync);
    const attempt = googleSheetRowIndexRetryAttemptRef.current + 1;
    console.log(
      `[googleRowIndex] rebuildStart spreadsheetId=${meta.spreadsheetId} sheetTitle=${writeSheetTitle}`,
    );
    console.log(`[googleRowIndex] rebuildAttempt attempt=${attempt}`);
    console.log("[googleRowIndex] build start source=api");
    console.log(
      `[googleSheetImportPerf] metadataTimeoutMs=${googleSheetRowIndexRequestTimeoutMs}`,
    );
    const rowIndexBuildStartedAt = Date.now();
    const controller = new AbortController();
    const timeoutId = window.setTimeout(
      () => controller.abort(),
      googleSheetRowIndexRequestTimeoutMs,
    );
    let metadataMsLogged = false;
    try {
      const response = await fetch("/api/google-sheet/row-index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          spreadsheetId: meta.spreadsheetId,
          sheetTitle: meta.sheetTitle,
          manualSheetTitle: writeSheetTitle,
          force,
        }),
      });
      console.log(
        `[googleSheetImportPerf] metadataMs=${Date.now() - rowIndexBuildStartedAt}`,
      );
      metadataMsLogged = true;
      const result = (await response.json().catch(() => null)) as
        | GoogleSheetRowIndexResponse
        | null;

      if (!response.ok || !result?.success) {
        const error =
          result?.technicalDetail?.trim() ||
          result?.error?.trim() ||
          `Google row index failed: HTTP ${response.status}`;
        const rebuildError = new Error(error) as Error & {
          networkIssue?: boolean;
        };
        rebuildError.networkIssue =
          Boolean(result?.networkIssue) || response.status === 503;
        throw rebuildError;
      }

      const nextIndex: GoogleSheetRowIndexState = {
        spreadsheetId: result.spreadsheetId,
        sheetTitle: result.sheetTitle,
        range: result.range,
        cacheVersion: result.cacheVersion ?? googleSheetRowIndexCacheVersion,
        rowCount: result.rowCount,
        indexedEventCount: result.indexedEventCount,
        entries: result.entries,
        debugRows: result.debugRows ?? [],
        builtAt: Date.now(),
      };
      setGoogleSheetRowIndex(nextIndex);
      googleSheetRowIndexRef.current = nextIndex;
      setGoogleRowIndexStatus("ready");
      googleRowIndexStatusRef.current = "ready";
      setGoogleRowIndexLastError(null);
      googleRowIndexLastErrorRef.current = null;
      googleSheetRowIndexNetworkIssueRef.current = false;
      googleSheetSyncMappingIssueRef.current = false;
      googleSheetRowIndexRetryAttemptRef.current = 0;
      clearScheduledGoogleRowIndexRebuild();
      setGoogleSheetRowIndexError(null);
      const requeuedSkippedCount =
        requeueResolvedSkippedGoogleSheetWritebacks(nextIndex);
      if (pendingSheetUpdatesRef.current.size === 0) {
        setSheetSyncStatus("idle");
        setSheetSyncError(labels.google.syncReady);
      }
      console.log(`[googleRowIndex] rows=${nextIndex.rowCount}`);
      console.log(`[googleRowIndex] mappedEvents=${nextIndex.indexedEventCount}`);
      for (const eventName of googleRowIndexDiagnosticEvents) {
        const entry = getGoogleSheetRowIndexEntry(nextIndex, eventName);
        const rowNumber =
          entry?.rowNumbers.length === 1 ? entry.rowNumbers[0] : null;
        console.log(`[googleRowIndex] sample ${eventName}=${rowNumber ?? "null"}`);
      }
      console.log(
        `[googleRowIndex] build success durationMs=${
          Date.now() - rowIndexBuildStartedAt
        }`,
      );
      console.log(
        `[googleRowIndex] build success mappedEvents=${nextIndex.indexedEventCount}`,
      );
      console.log(`[googleRowIndex] requeuedSkipped=${requeuedSkippedCount}`);
      console.log(
        `[googleRowIndex] rebuildSuccess sheetTitle=${nextIndex.sheetTitle} rowsRead=${nextIndex.rowCount} indexSize=${nextIndex.indexedEventCount}`,
      );
      console.log("[googleSheetRowIndexUI] rebuilt", {
        spreadsheetId: nextIndex.spreadsheetId,
        sheetTitle: nextIndex.sheetTitle,
        range: nextIndex.range,
        rowCount: nextIndex.rowCount,
        indexedEventCount: nextIndex.indexedEventCount,
      });
      logGoogleSheetRowIndexDiagnostics(nextIndex);
      for (const eventName of googleRowIndexDiagnosticEvents) {
        const target = getGoogleSheetRowIndexWriteTarget(nextIndex, eventName);
        console.log(
          `[googleSheetRowIndexUI] expected event=${eventName} rowNumber=${
            target.rowNumber ?? "null"
          } reason=${target.reason ?? "null"}`,
        );
      }
      const checkboxColumnIndex = getSelectedGoogleSheetCheckboxColumnIndex(
        meta,
        manualCheckboxColumnInputRef.current,
      );
      if (
        pendingSheetUpdatesRef.current.size > 0 &&
        checkboxColumnIndex !== null
      ) {
        const previewLines = Array.from(pendingSheetUpdatesRef.current.values())
          .slice(0, 10)
          .map((update) => {
            const target = getGoogleSheetRowIndexWriteTarget(
              nextIndex,
              update.eventName,
            );
            const expectedRange =
              target.rowNumber === null
                ? "null"
                : buildGoogleSheetA1Range(
                    writeSheetTitle,
                    checkboxColumnIndex,
                    target.rowNumber,
                  );
            return `${update.eventName} -> ${
              target.rowNumber ?? "null"
            } -> ${expectedRange} -> leaf=${
              target.debugRow?.leaf ?? target.rowNumber !== null
            } -> parent=${target.debugRow?.parent ?? false} -> gValue=${
              target.debugRow?.gValue || "null"
            } -> gIsBooleanLike=${
              target.debugRow?.gIsBooleanLike ?? false
            }${
              target.reason ? ` (blocked: ${target.reason})` : ""
            }`;
          });
        setGoogleSheetWriteTargetPreview(previewLines);
      }
      const shouldScheduleSync =
        options.scheduleSyncAfter !== false &&
        nextIndex.indexedEventCount > 0 &&
        pendingSheetUpdatesRef.current.size > 0 &&
        autoUpdateGoogleSheetRef.current &&
        googleAuthConnectedRef.current &&
        !isSheetSyncFlushingRef.current;
      console.log(
        `[googleRowIndex] afterRebuild pending=${pendingSheetUpdatesRef.current.size} scheduleSync=${shouldScheduleSync}`,
      );
      if (shouldScheduleSync) {
        scheduleNextGoogleSheetFlushBecausePendingRef.current?.(0, {
          replaceExisting: true,
        });
      }
      return nextIndex;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : labels.google.sheetSyncFailed;
      const isNetworkIssue =
        Boolean((error as { networkIssue?: boolean } | null)?.networkIssue) ||
        isGoogleSheetNetworkIssueMessage(message);
      if (isNetworkIssue) {
        googleSheetRowIndexNetworkIssueRef.current = true;
        const pendingCount = pendingSheetUpdatesRef.current.size;
        const retryDelayMs = getGoogleSheetSyncRetryDelayMs(
          googleSheetRowIndexRetryAttemptRef.current,
        );
        const canScheduleRetry =
          options.scheduleRetryOnNetwork !== false &&
          googleAuthConnectedRef.current &&
          googleSheetSyncMetaRef.current !== null;
        let scheduled = false;
        if (canScheduleRetry) {
          clearScheduledGoogleRowIndexRebuild();
          const retryAt = Date.now() + retryDelayMs;
          setNextGoogleRowIndexRetryAt(retryAt);
          setNextGoogleRowIndexRetrySeconds(Math.ceil(retryDelayMs / 1000));
          googleSheetRowIndexRetryTimerRef.current = window.setTimeout(() => {
            googleSheetRowIndexRetryTimerRef.current = null;
            setNextGoogleRowIndexRetryAt(null);
            setNextGoogleRowIndexRetrySeconds(null);
            void rebuildGoogleSheetRowIndex(force, {
              ...options,
              resetRetryAttempt: false,
            });
          }, retryDelayMs);
          scheduled = true;
        }
        if (scheduled) {
          googleSheetRowIndexRetryAttemptRef.current += 1;
          setGoogleRowIndexStatus("building");
          googleRowIndexStatusRef.current = "building";
        } else {
          setGoogleRowIndexStatus("failed");
          googleRowIndexStatusRef.current = "failed";
        }
        setGoogleRowIndexLastError(message);
        googleRowIndexLastErrorRef.current = message;
        console.log(
          `[googleRowIndex] rebuildNetworkIssue retryInMs=${
            scheduled ? retryDelayMs : "null"
          } technicalDetail=${message}`,
        );
        setPendingSheetUpdateCount(pendingCount);
        setSheetSyncStatus(pendingCount > 0 ? "pending" : "idle");
        setLastGoogleSheetSyncStatus(null);
        setLastGoogleSheetSyncUpdatedRows([]);
        setSheetSyncError(`${labels.google.networkRetry} (Google row index)`);
        setLastGoogleSheetMappingDebugInfo((current) =>
          [
            `Google row index network issue: ${message}`,
            ...(current?.split("\n") ?? []),
          ]
            .slice(0, 5)
            .join("\n"),
        );
        return null;
      }
      googleSheetRowIndexNetworkIssueRef.current = false;
      setGoogleRowIndexStatus("failed");
      googleRowIndexStatusRef.current = "failed";
      setGoogleRowIndexLastError(message);
      googleRowIndexLastErrorRef.current = message;
      setGoogleSheetRowIndexError(message);
      setSheetSyncStatus("failed");
      setSheetSyncError(`${labels.google.rowIndexFailed}: ${message}`);
      clearScheduledGoogleRowIndexRebuild();
      console.log(`[googleRowIndex] rebuildFailed error=${message}`);
      console.log(`[googleRowIndex] build failed error=${message}`);
      return null;
    } finally {
      window.clearTimeout(timeoutId);
      if (!metadataMsLogged) {
        console.log(
          `[googleSheetImportPerf] metadataMs=${
            Date.now() - rowIndexBuildStartedAt
          }`,
        );
      }
      isGoogleSheetRowIndexRebuildingRef.current = false;
      setIsRebuildingGoogleRowIndex(false);
      console.log("[googleRowIndex] rebuildFinally inFlight=false");
    }
  }, [
    clearScheduledGoogleRowIndexRebuild,
    labels.google,
    requeueResolvedSkippedGoogleSheetWritebacks,
  ]);

  const ensureGoogleSheetRowIndex = useCallback(async () => {
    const meta = googleSheetSyncMetaRef.current;
    const current = googleSheetRowIndexRef.current;
    if (isGoogleSheetRowIndexReadyForMeta(current, meta)) {
      return current;
    }
    return getOrBuildGoogleSheetImportStaircaseIndex(meta);
  }, [getOrBuildGoogleSheetImportStaircaseIndex]);

  const rememberGoogleSheetSyncDebug = useCallback(
    (result: GoogleSheetSyncResponse | null | undefined) => {
      setLastGoogleSheetSyncRanges(compactDebugList(result?.ranges, 5));
      setLastGoogleSheetSyncApiStatus(
        typeof result?.apiStatus === "number" ? result.apiStatus : null,
      );
      setLastGoogleSheetSyncTotalUpdatedCells(
        typeof result?.totalUpdatedCells === "number"
          ? result.totalUpdatedCells
          : null,
      );
      setLastGoogleSheetSyncTotalUpdatedRows(
        typeof result?.totalUpdatedRows === "number"
          ? result.totalUpdatedRows
          : null,
      );
    },
    [],
  );

  const clearScheduledSheetSyncFlush = useCallback(() => {
    if (sheetSyncTimerRef.current !== null) {
      window.clearTimeout(sheetSyncTimerRef.current);
      sheetSyncTimerRef.current = null;
    }
    sheetSyncScheduledAtRef.current = null;
    setNextSheetSyncRetryAt(null);
    setNextSheetSyncRetrySeconds(null);
  }, []);

  const resetSheetSyncInFlight = useCallback((finishedAt = Date.now()) => {
    isSheetSyncFlushingRef.current = false;
    sheetSyncStartedAtRef.current = null;
    lastSheetSyncFinishedAtRef.current = finishedAt;
    setSheetSyncInFlight(false);
    setSheetSyncStartedAt(null);
    setLastSheetSyncFinishedAt(finishedAt);
    console.log("[googleSheetAutoSync] cleanup inFlight=false");
  }, []);

  const resetStaleSheetSyncInFlightIfNeeded = useCallback((): boolean => {
    if (!isSheetSyncFlushingRef.current) {
      return false;
    }
    const startedAt = sheetSyncStartedAtRef.current;
    const now = Date.now();
    if (startedAt !== null && now - startedAt < googleSheetSyncStaleInFlightMs) {
      return false;
    }
    console.warn("[googleSheetAutoSync] stale inFlight reset");
    resetSheetSyncInFlight(now);
    setLastGoogleSheetSyncStatus("failed");
    setLastGoogleSheetSyncUpdatedRows([]);
    if (pendingSheetUpdatesRef.current.size > 0) {
      setPendingSheetUpdateCount(pendingSheetUpdatesRef.current.size);
      setSheetSyncStatus("pending");
      setSheetSyncError(labels.google.syncTimeoutRetry);
    }
    return true;
  }, [labels.google, resetSheetSyncInFlight]);

  const scheduleSheetSyncFlush = useCallback(
    (
      delayMs = googleSheetSyncDefaultDelayMs,
      options: { showRetryCountdown?: boolean; replaceExisting?: boolean } = {},
    ): boolean => {
      const pending = pendingSheetUpdatesRef.current.size;
      const autoUpdate = autoUpdateGoogleSheetRef.current;
      console.log(
        `[googleSheetAutoSync] pending=${pending} autoUpdate=${autoUpdate} scheduleRetryInMs=${delayMs}`,
      );
      if (!autoUpdate || pending <= 0 || !googleAuthConnectedRef.current) {
        return false;
      }

      const scheduledAt = Date.now() + delayMs;
      if (
        sheetSyncTimerRef.current !== null &&
        sheetSyncScheduledAtRef.current !== null &&
        sheetSyncScheduledAtRef.current <= scheduledAt &&
        !options.replaceExisting
      ) {
        return false;
      }

      clearScheduledSheetSyncFlush();
      if (options.showRetryCountdown) {
        setNextSheetSyncRetryAt(scheduledAt);
        setNextSheetSyncRetrySeconds(Math.ceil(delayMs / 1000));
      }
      sheetSyncScheduledAtRef.current = scheduledAt;
      const fireRetry = () => {
        sheetSyncTimerRef.current = null;
        sheetSyncScheduledAtRef.current = null;
        setNextSheetSyncRetryAt(null);
        setNextSheetSyncRetrySeconds(null);
        console.log("[googleSheetAutoSync] retry fired");
        if (isSheetSyncFlushingRef.current) {
          const staleReset = resetStaleSheetSyncInFlightIfNeeded();
          if (staleReset) {
            void flushSheetSyncQueueRef.current?.("auto");
            return;
          }
          console.log("[googleSheetAutoSync] skipped because inFlight=true");
          const pending = pendingSheetUpdatesRef.current.size;
          if (
            pending <= 0 ||
            !autoUpdateGoogleSheetRef.current ||
            !googleAuthConnectedRef.current
          ) {
            return;
          }
          const startedAt = sheetSyncStartedAtRef.current;
          const elapsed = startedAt === null ? 0 : Date.now() - startedAt;
          const staleDelayMs = Math.max(
            getGoogleSheetSyncRetryDelayMs(0),
            googleSheetSyncStaleInFlightMs - elapsed + 100,
          );
          console.log(
            `[googleSheetAutoSync] scheduleNextBecausePending pending=${pending} delay=${staleDelayMs}`,
          );
          const retryAt = Date.now() + staleDelayMs;
          sheetSyncScheduledAtRef.current = retryAt;
          if (options.showRetryCountdown) {
            setNextSheetSyncRetryAt(retryAt);
            setNextSheetSyncRetrySeconds(Math.ceil(staleDelayMs / 1000));
          }
          sheetSyncTimerRef.current = window.setTimeout(
            fireRetry,
            staleDelayMs,
          );
          return;
        }
        void flushSheetSyncQueueRef.current?.("auto");
      };
      sheetSyncTimerRef.current = window.setTimeout(fireRetry, delayMs);
      return true;
    },
    [clearScheduledSheetSyncFlush, resetStaleSheetSyncInFlightIfNeeded],
  );

  const scheduleNextGoogleSheetFlushBecausePending = useCallback(
    (
      delayMs = googleSheetSyncDefaultDelayMs,
      options: {
        replaceExisting?: boolean;
        showRetryCountdown?: boolean;
      } = {},
    ): boolean => {
      const pending = pendingSheetUpdatesRef.current.size;
      if (
        pending <= 0 ||
        !autoUpdateGoogleSheetRef.current ||
        !googleAuthConnectedRef.current
      ) {
        return false;
      }
      console.log(
        `[googleSheetAutoSync] scheduleNextBecausePending pending=${pending} delay=${delayMs}`,
      );
      return scheduleSheetSyncFlush(delayMs, {
        showRetryCountdown: options.showRetryCountdown ?? false,
        replaceExisting: options.replaceExisting,
      });
    },
    [scheduleSheetSyncFlush],
  );
  scheduleNextGoogleSheetFlushBecausePendingRef.current =
    scheduleNextGoogleSheetFlushBecausePending;

  const scheduleGoogleSheetNetworkRetry = useCallback((): number | null => {
    const pending = pendingSheetUpdatesRef.current.size;
    if (
      pending <= 0 ||
      !autoUpdateGoogleSheetRef.current ||
      !googleAuthConnectedRef.current
    ) {
      return null;
    }

    const retryDelayMs = getGoogleSheetSyncRetryDelayMs(
      sheetSyncRetryAttemptRef.current,
    );
    const scheduled = scheduleNextGoogleSheetFlushBecausePending(retryDelayMs, {
      replaceExisting: true,
      showRetryCountdown: true,
    });
    if (scheduled) {
      sheetSyncRetryAttemptRef.current += 1;
    }
    return scheduled ? retryDelayMs : null;
  }, [scheduleNextGoogleSheetFlushBecausePending]);

  const captureCurrentPlatformWorkspace =
    useCallback((): PlatformWorkspaceState => {
      return {
        importResult,
        originalWorkbookBuffer: originalWorkbookBufferRef.current,
        selectedRowId,
        importError,
        googleSheetUrl,
        googleSheetError,
        lastXlsxImportDebugInfo,
        googleSheetImportInfo,
        googleSheetImportErrorDebug,
        googleSheetSourceUrl,
        googleSheetSyncMeta,
        manualSheetTitleInput,
        manualCheckboxColumnInput,
        manualCheckboxColumnError,
        manualGoogleSheetSyncSettings: {
          ...manualGoogleSheetSyncSettingsRef.current,
        },
        autoUpdateGoogleSheet,
        previewGoogleSheetWriteTargets,
        googleSheetWriteTargetPreview: [...googleSheetWriteTargetPreview],
        googleSheetRowIndex,
        unknownLiveResults: [...unknownLiveResults],
        matchBundle,
        logText,
        unityManualEventInput,
        iosLunarConsoleInput,
        processMessage,
        activeSidebarFilter,
        activeEventGroupTab,
        liveDuplicateSeenByEventName: new Map(
          liveDuplicateSeenByEventNameRef.current,
        ),
        pendingSheetUpdates: new Map(pendingSheetUpdatesRef.current),
        skippedGoogleSheetWritebacks: [
          ...skippedGoogleSheetWritebacksRef.current.values(),
        ],
        syncedGoogleSheetRowIds: new Set(syncedGoogleSheetRowIdsRef.current),
        sheetSyncSeenLogIds: new Set(sheetSyncSeenLogIdsRef.current),
        pendingSheetUpdateCount,
        sheetSyncStatus,
        sheetSyncError,
        sheetSyncStartedAt,
        lastSheetSyncAttemptAt,
        lastSheetSyncFinishedAt,
        lastGoogleSheetSyncStatus,
        lastGoogleSheetSyncUpdatedRows: [...lastGoogleSheetSyncUpdatedRows],
        lastGoogleSheetSyncRanges: [...lastGoogleSheetSyncRanges],
        lastGoogleSheetSyncApiStatus,
        lastGoogleSheetSyncTotalUpdatedCells,
        lastGoogleSheetSyncTotalUpdatedRows,
        lastGoogleSheetMappingDebugInfo,
        googleRowIndexStatus,
        googleRowIndexLastError,
        lastWritebackLookupFailure: lastWritebackLookupFailureRef.current,
      };
    }, [
      activeEventGroupTab,
      activeSidebarFilter,
      autoUpdateGoogleSheet,
      googleRowIndexLastError,
      googleRowIndexStatus,
      googleSheetError,
      googleSheetImportErrorDebug,
      googleSheetImportInfo,
      googleSheetRowIndex,
      googleSheetSourceUrl,
      googleSheetSyncMeta,
      googleSheetUrl,
      googleSheetWriteTargetPreview,
      importError,
      importResult,
      lastGoogleSheetMappingDebugInfo,
      lastGoogleSheetSyncApiStatus,
      lastGoogleSheetSyncRanges,
      lastGoogleSheetSyncStatus,
      lastGoogleSheetSyncTotalUpdatedCells,
      lastGoogleSheetSyncTotalUpdatedRows,
      lastGoogleSheetSyncUpdatedRows,
      lastXlsxImportDebugInfo,
      logText,
      manualCheckboxColumnError,
      manualCheckboxColumnInput,
      manualSheetTitleInput,
      matchBundle,
      pendingSheetUpdateCount,
      previewGoogleSheetWriteTargets,
      processMessage,
      selectedRowId,
      sheetSyncStartedAt,
      lastSheetSyncAttemptAt,
      lastSheetSyncFinishedAt,
      sheetSyncError,
      sheetSyncStatus,
      unityManualEventInput,
      iosLunarConsoleInput,
      unknownLiveResults,
    ]);

  const restorePlatformWorkspace = useCallback(
    (workspace: PlatformWorkspaceState) => {
      clearScheduledSheetSyncFlush();
      clearScheduledGoogleRowIndexRebuild();
      clearScheduledGoogleSheetTitleResolve();
      if (googleSheetImportRetryTimerRef.current !== null) {
        window.clearTimeout(googleSheetImportRetryTimerRef.current);
        googleSheetImportRetryTimerRef.current = null;
      }
      setNextGoogleSheetImportRetryAt(null);
      setNextGoogleSheetImportRetrySeconds(null);
      googleSheetRowIndexRetryAttemptRef.current = 0;
      googleSheetTitleRetryAttemptRef.current = 0;
      googleSheetRowIndexNetworkIssueRef.current = false;
      setImportResult(workspace.importResult);
      importResultRef.current = workspace.importResult;
      originalWorkbookBufferRef.current = workspace.originalWorkbookBuffer;
      setSelectedRowId(workspace.selectedRowId);
      setImportError(workspace.importError);
      setGoogleSheetUrl(workspace.googleSheetUrl);
      setGoogleSheetError(workspace.googleSheetError);
      setLastXlsxImportDebugInfo(workspace.lastXlsxImportDebugInfo);
      setGoogleSheetImportInfo(workspace.googleSheetImportInfo);
      setGoogleSheetImportErrorDebug(workspace.googleSheetImportErrorDebug);
      setGoogleSheetSourceUrl(workspace.googleSheetSourceUrl);
      setGoogleSheetSyncMeta(workspace.googleSheetSyncMeta);
      googleSheetSyncMetaRef.current = workspace.googleSheetSyncMeta;
      setManualSheetTitleInput(workspace.manualSheetTitleInput);
      setManualCheckboxColumnInput(workspace.manualCheckboxColumnInput);
      manualCheckboxColumnInputRef.current = workspace.manualCheckboxColumnInput;
      setManualCheckboxColumnError(workspace.manualCheckboxColumnError);
      manualGoogleSheetSyncSettingsRef.current = {
        ...workspace.manualGoogleSheetSyncSettings,
      };
      setAutoUpdateGoogleSheet(workspace.autoUpdateGoogleSheet);
      autoUpdateGoogleSheetRef.current = workspace.autoUpdateGoogleSheet;
      setPreviewGoogleSheetWriteTargets(workspace.previewGoogleSheetWriteTargets);
      previewGoogleSheetWriteTargetsRef.current =
        workspace.previewGoogleSheetWriteTargets;
      setGoogleSheetWriteTargetPreview([
        ...workspace.googleSheetWriteTargetPreview,
      ]);
      setGoogleSheetRowIndex(workspace.googleSheetRowIndex);
      googleSheetRowIndexRef.current = workspace.googleSheetRowIndex;
      setGoogleRowIndexStatus(workspace.googleRowIndexStatus);
      googleRowIndexStatusRef.current = workspace.googleRowIndexStatus;
      setGoogleRowIndexLastError(workspace.googleRowIndexLastError);
      googleRowIndexLastErrorRef.current = workspace.googleRowIndexLastError;
      setUnknownLiveResults([...workspace.unknownLiveResults]);
      unknownLiveResultsRef.current = [...workspace.unknownLiveResults];
      unknownLiveLogIdsRef.current = new Set(
        workspace.unknownLiveResults.map((result) => result.logId),
      );
      setMatchBundle(workspace.matchBundle);
      setLogText(workspace.logText);
      setUnityManualEventInput(workspace.unityManualEventInput);
      setIosLunarConsoleInput(workspace.iosLunarConsoleInput);
      setProcessMessage(workspace.processMessage);
      setActiveSidebarFilter(workspace.activeSidebarFilter);
      setActiveEventGroupTab(workspace.activeEventGroupTab ?? "all");
      liveDuplicateSeenByEventNameRef.current = new Map(
        workspace.liveDuplicateSeenByEventName,
      );
      pendingSheetUpdatesRef.current = new Map(workspace.pendingSheetUpdates);
      skippedGoogleSheetWritebacksRef.current = new Map(
        workspace.skippedGoogleSheetWritebacks.map((skipped) => [
          skipped.rowId,
          skipped,
        ]),
      );
      setSkippedGoogleSheetWritebacks([
        ...workspace.skippedGoogleSheetWritebacks,
      ]);
      lastWritebackLookupFailureRef.current =
        workspace.lastWritebackLookupFailure;
      setLastWritebackLookupFailure(workspace.lastWritebackLookupFailure);
      syncedGoogleSheetRowIdsRef.current = new Set(
        workspace.syncedGoogleSheetRowIds,
      );
      sheetSyncSeenLogIdsRef.current = new Set(workspace.sheetSyncSeenLogIds);
      setPendingSheetUpdateCount(pendingSheetUpdatesRef.current.size);
      setSheetSyncStatus(workspace.sheetSyncStatus);
      setSheetSyncError(workspace.sheetSyncError);
      isSheetSyncFlushingRef.current = false;
      sheetSyncStartedAtRef.current = workspace.sheetSyncStartedAt;
      lastSheetSyncAttemptAtRef.current = workspace.lastSheetSyncAttemptAt;
      lastSheetSyncFinishedAtRef.current = workspace.lastSheetSyncFinishedAt;
      setSheetSyncInFlight(false);
      setSheetSyncStartedAt(workspace.sheetSyncStartedAt);
      setLastSheetSyncAttemptAt(workspace.lastSheetSyncAttemptAt);
      setLastSheetSyncFinishedAt(workspace.lastSheetSyncFinishedAt);
      setLastGoogleSheetSyncStatus(workspace.lastGoogleSheetSyncStatus);
      setLastGoogleSheetSyncUpdatedRows([
        ...workspace.lastGoogleSheetSyncUpdatedRows,
      ]);
      setLastGoogleSheetSyncRanges([...workspace.lastGoogleSheetSyncRanges]);
      setLastGoogleSheetSyncApiStatus(workspace.lastGoogleSheetSyncApiStatus);
      setLastGoogleSheetSyncTotalUpdatedCells(
        workspace.lastGoogleSheetSyncTotalUpdatedCells,
      );
      setLastGoogleSheetSyncTotalUpdatedRows(
        workspace.lastGoogleSheetSyncTotalUpdatedRows,
      );
      setLastGoogleSheetMappingDebugInfo(
        workspace.lastGoogleSheetMappingDebugInfo,
      );
      setGoogleSheetRowIndexError(null);
      setAndroidSpecRequiredError(null);
      setHighlightedMatchResultIds([]);
      setHighlightedTableRowIds([]);
      setRecentResultsScrollSignal(0);
      setTableScrollSignal(0);
      knownMatchResultIdsRef.current = new Set();
      knownTableLogIdsRef.current = new Set();
    },
    [
      clearScheduledGoogleRowIndexRebuild,
      clearScheduledGoogleSheetTitleResolve,
      clearScheduledSheetSyncFlush,
    ],
  );

  const handleActivePlatformChange = useCallback(
    (nextPlatform: PlatformMode) => {
      const currentPlatform = activePlatformRef.current;
      if (
        nextPlatform === currentPlatform ||
        activePlatform !== currentPlatform ||
        isSheetSyncFlushingRef.current ||
        isImportingRef.current ||
        isImportingGoogleSheetRef.current
      ) {
        return;
      }

      platformWorkspacesRef.current[currentPlatform] =
        captureCurrentPlatformWorkspace();
      activePlatformRef.current = nextPlatform;
      setActivePlatform(nextPlatform);
      setAutoUpdateAttemptedWithoutRequirements(false);
      restorePlatformWorkspace(platformWorkspacesRef.current[nextPlatform]);
    },
    [activePlatform, captureCurrentPlatformWorkspace, restorePlatformWorkspace],
  );

  const buildGoogleSheetSyncPayload = useCallback((rowIndexOverride?: GoogleSheetRowIndexState | null) => {
    const meta = googleSheetSyncMetaRef.current;
    if (!meta) {
      return null;
    }
    const checkboxColumnIndex = fixedGoogleSheetCheckboxColumnIndex;
    const statusColumnIndex = getGoogleSheetStatusColumnIndex(meta);
    const writeSheetTitle = getGoogleSheetWriteSheetTitle(meta);
    if (writeSheetTitle === null) {
      return null;
    }
    const rowIndex =
      rowIndexOverride ?? getOrBuildGoogleSheetImportStaircaseIndex(meta);
    if (!rowIndex) {
      setSheetSyncStatus("pending");
      setSheetSyncError("Google Sheet writeback index is not built from import.");
      return null;
    }
    let skippedNoTargetCount = 0;
    googleSheetSyncMappingIssueRef.current = false;
    const pendingCount = pendingSheetUpdatesRef.current.size;
    const updates: Array<{
      rowId: string;
      rowNumber: number;
      eventName: string;
      checkboxColumnIndex: number;
      statusColumnIndex: number | null;
      doneColumnIndex: number;
      checkColumnIndex: number | null;
    }> = [];
    for (const update of pendingSheetUpdatesRef.current.values()) {
      if (updates.length >= googleSheetSyncBatchSize) {
        break;
      }
      const matchedRowId = update.matchedRowId ?? update.rowId;
      const target = resolveGoogleSheetImportStaircaseWriteTarget(update, {
        writeSheetTitle,
        rowIndex,
      });
      console.log(
        `[googleSheetWritebackTarget] eventFromLive=${update.eventName} normalizedEventFromLive=${normalizeGoogleSheetEventName(
          update.eventName,
        )} matchedRowId=${matchedRowId} matchedGoogleRow=${
          target.rowNumber ?? "null"
        } sourceRowNumber=${target.rowNumber ?? "null"} range=${
          target.range ?? "null"
        } source=${target.source ?? "none"}`,
      );
      if (target.reason !== null || target.rowNumber === null) {
        const failure = recordGoogleSheetWritebackLookupFailure({
          update,
          target: {
            rowNumber: target.rowNumber,
            reason: target.reason,
            candidates: target.candidates,
            debugRow: target.debugRow,
          },
          matchedRowId,
        });
        skippedNoTargetCount += 1;
        rememberSkippedGoogleSheetWriteback(failure);
        pendingSheetUpdatesRef.current.delete(update.rowId);
        setLastGoogleSheetMappingDebugInfo((current) =>
          [
            `eventFromLive=${update.eventName} normalizedEventFromLive=${normalizeGoogleSheetEventName(
              update.eventName,
            )} sourceRowNumber=null matchedGoogleRow=null range=null source=${
              rowIndex.source ?? "none"
            } skippedReason=${failure.reason}`,
            ...(current?.split("\n") ?? []),
          ]
            .slice(0, 5)
            .join("\n"),
        );
        console.warn(
          `[googleSheetSync] skippedNoGoogleTarget event=${update.eventName} rowId=${update.rowId}`,
        );
        console.warn("[googleSheetRowIndex] blocked pending write", {
          rowId: update.rowId,
          eventName: update.eventName,
          reason: target.reason,
          candidates: target.candidates,
        });
        continue;
      }
      forgetSkippedGoogleSheetWriteback(update.rowId);
      setLastGoogleSheetTargetRange(target.range);
      setLastGoogleSheetMappingDebugInfo((current) =>
        [
          `eventFromLive=${update.eventName} normalizedEventFromLive=${normalizeGoogleSheetEventName(
            update.eventName,
          )} sourceRowNumber=${target.rowNumber} matchedGoogleRow=${
            target.rowNumber
          } range=${target.range} source=${target.source} skippedReason=null`,
          ...(current?.split("\n") ?? []),
        ]
          .slice(0, 5)
          .join("\n"),
      );
      updates.push({
        rowId: update.rowId,
        rowNumber: target.rowNumber,
        eventName: update.eventName,
        checkboxColumnIndex,
        statusColumnIndex,
        doneColumnIndex: checkboxColumnIndex,
        checkColumnIndex: statusColumnIndex,
      });
    }
    console.log(
      `[googleSheetSync] rangesBuilt=${updates.length} pending=${pendingCount}`,
    );
    if (skippedNoTargetCount > 0) {
      setPendingSheetUpdateCount(pendingSheetUpdatesRef.current.size);
      setSheetSyncError(
        labels.google.skippedEventsWithoutCheckboxRow(skippedNoTargetCount),
      );
    }
    if (updates.length === 0) {
      googleSheetSyncMappingIssueRef.current = false;
      if (skippedNoTargetCount > 0) {
        setSheetSyncStatus("idle");
        setSheetSyncError(labels.google.noCheckboxRowsForPendingEvents);
        setLastGoogleSheetSyncStatus(null);
        setLastGoogleSheetSyncUpdatedRows([]);
        setLastGoogleSheetSyncRanges([]);
        setLastGoogleSheetSyncApiStatus(null);
        setLastGoogleSheetSyncTotalUpdatedCells(null);
        setLastGoogleSheetSyncTotalUpdatedRows(null);
      }
      return null;
    }
    googleSheetSyncMappingIssueRef.current = false;
    return {
      spreadsheetId: meta.spreadsheetId,
      gid: meta.gid,
      sheetTitle: meta.sheetTitle,
      manualSheetTitle: meta.manualSheetTitle,
      updates,
      skippedNoTargetCount,
    };
  }, [
    forgetSkippedGoogleSheetWriteback,
    getOrBuildGoogleSheetImportStaircaseIndex,
    labels.google,
    recordGoogleSheetWritebackLookupFailure,
    rememberSkippedGoogleSheetWriteback,
  ]);

  const flushSheetSyncQueue = useCallback(async (
    reason: "auto" | "manual" = "auto",
  ) => {
    if (isSheetSyncFlushingRef.current) {
      const staleReset = resetStaleSheetSyncInFlightIfNeeded();
      if (!staleReset) {
        console.log(
          `[googleSheetAutoSync] start reason=${reason} inFlight=true`,
        );
        console.log("[googleSheetAutoSync] skipped because inFlight=true");
        if (reason === "manual") {
          setSheetSyncError(labels.google.syncInProgress);
        }
        return;
      }
    }
    if (isSheetSyncFlushingRef.current) {
      console.log("[googleSheetAutoSync] skipped because inFlight=true");
      return;
    }
    const pendingAtStart = pendingSheetUpdatesRef.current.size;
    console.log(`[googleSheetAutoSync] start reason=${reason}`);
    console.log(`[googleSheetAutoSync] pending=${pendingAtStart}`);
    console.log(
      `[googleSheetAutoSync] inFlight=${isSheetSyncFlushingRef.current}`,
    );
    console.log(`[googleSheetAutoSync] timeoutMs=${googleSheetSyncRequestTimeoutMs}`);
    console.log(`[googleSheetAutoSync] flushStart pending=${pendingAtStart}`);
    if (pendingAtStart <= 0) {
      setPendingSheetUpdateCount(0);
      return;
    }
    clearScheduledSheetSyncFlush();
    if (previewGoogleSheetWriteTargetsRef.current) {
      setSheetSyncStatus("idle");
      setSheetSyncError(labels.google.previewNoWrites);
      return;
    }

    const requestStartedAt = Date.now();
    isSheetSyncFlushingRef.current = true;
    sheetSyncStartedAtRef.current = requestStartedAt;
    lastSheetSyncAttemptAtRef.current = requestStartedAt;
    setSheetSyncInFlight(true);
    setSheetSyncStartedAt(requestStartedAt);
    setLastSheetSyncAttemptAt(requestStartedAt);
    setLastSheetSyncFinishedAt(null);
    console.log(`[googleSheetAutoSync] requestStartedAt=${requestStartedAt}`);
    let abortTimerId: number | null = null;
    let allowImmediateFollowUp = false;
    try {
      if (!googleAuthConnectedRef.current) {
        setSheetSyncStatus("failed");
        setSheetSyncError(labels.google.authRequired);
        return;
      }

      const payload = buildGoogleSheetSyncPayload();
      if (!payload) {
        if (googleSheetSyncMappingIssueRef.current) {
          console.log(
            `[googleSheetAutoSync] noTargetRanges pendingLeft=${pendingSheetUpdatesRef.current.size}`,
          );
        }
        return;
      }

      const meta = googleSheetSyncMetaRef.current;
      const firstUpdate = payload.updates[0] ?? null;
      const writeSheetTitle = getGoogleSheetWriteSheetTitle(meta);
      if (
        firstUpdate &&
        writeSheetTitle !== null &&
        typeof firstUpdate.checkboxColumnIndex === "number"
      ) {
        setLastGoogleSheetTargetRange(
          buildGoogleSheetA1Range(
            writeSheetTitle,
            firstUpdate.checkboxColumnIndex,
            firstUpdate.rowNumber,
          ),
        );
      }
      if (writeSheetTitle !== null) {
        setLastGoogleSheetSyncRanges(
          payload.updates
            .map((update) =>
              buildGoogleSheetA1Range(
                writeSheetTitle,
                update.checkboxColumnIndex,
                update.rowNumber,
              ),
            )
            .slice(-5),
        );
      }

      setSheetSyncStatus("syncing");
      setSheetSyncError(null);
      console.log(
        `[googleSheetAutoSync] sync start pending=${pendingAtStart} batchSize=${payload.updates.length}`,
      );
      const controller = new AbortController();
      abortTimerId = window.setTimeout(() => {
        controller.abort();
      }, googleSheetSyncRequestTimeoutMs);
      const response = await fetch("/api/google-sheet/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const result = (await response.json().catch(() => null)) as
        | GoogleSheetSyncResponse
        | null;
      if (abortTimerId !== null) {
        window.clearTimeout(abortTimerId);
        abortTimerId = null;
      }

      if (!response.ok || !result?.success) {
        rememberGoogleSheetSyncDebug(result);
        const isRetryableNetwork =
          Boolean(result?.networkIssue) || response.status === 503;
        if (isRetryableNetwork) {
          const pendingCount = pendingSheetUpdatesRef.current.size;
          console.log(
            `[googleSheetAutoSync] failed name=${
              result?.errorName ?? "GoogleSheetSyncError"
            } message=${
              result?.errorMessage ?? result?.error ?? response.status
            } retryable=true`,
          );
          setPendingSheetUpdateCount(pendingCount);
          if (pendingCount === 0) {
            setSheetSyncStatus("idle");
            setSheetSyncError(null);
            setLastGoogleSheetSyncStatus(null);
            setLastGoogleSheetSyncUpdatedRows([]);
            return;
          }
          setSheetSyncStatus("pending");
          setSheetSyncError(labels.google.networkRetry);
          setLastGoogleSheetSyncStatus("failed");
          setLastGoogleSheetSyncUpdatedRows([]);
          const nextRetry = scheduleGoogleSheetNetworkRetry();
          console.log(
            `[googleSheetAutoSync] sync failed retryInMs=${nextRetry ?? "null"} error=${
              result?.error ?? response.status
            }`,
          );
          return;
        }

        const error =
          result?.error ?? `${labels.google.sheetSyncFailed}: HTTP ${response.status}`;
        const detail = result?.technicalDetail?.trim();
        throw new Error(detail ? `${error} ${detail}` : error);
      }

      const updatedRowIds = Array.isArray(result.updatedRowIds)
        ? new Set(
            result.updatedRowIds.filter(
              (rowId): rowId is string => typeof rowId === "string",
            ),
          )
        : new Set(payload.updates.map((update) => update.rowId));

      for (const update of payload.updates) {
        if (!updatedRowIds.has(update.rowId)) {
          continue;
        }
        pendingSheetUpdatesRef.current.delete(update.rowId);
        syncedGoogleSheetRowIdsRef.current.add(update.rowId);
      }
      setPendingSheetUpdateCount(pendingSheetUpdatesRef.current.size);
      sheetSyncRetryAttemptRef.current = 0;
      setSheetSyncStatus(
        pendingSheetUpdatesRef.current.size > 0 ? "pending" : "synced",
      );
      setSheetSyncError(
        payload.skippedNoTargetCount > 0
          ? labels.google.skippedEventsWithoutCheckboxRow(
              payload.skippedNoTargetCount,
            )
          : null,
      );
      setLastGoogleSheetSyncStatus("success");
      setLastGoogleSheetSyncUpdatedRows([...updatedRowIds]);
      rememberGoogleSheetSyncDebug(result);
      console.log(
        `[googleSheetAutoSync] batchSuccess updated=${updatedRowIds.size} pendingLeft=${pendingSheetUpdatesRef.current.size}`,
      );
      console.log(
        `[googleSheetAutoSync] success pendingLeft=${pendingSheetUpdatesRef.current.size}`,
      );
      console.log(
        `[googleSheetAutoSync] sync success updatedRows=${updatedRowIds.size} durationMs=${
          Date.now() - requestStartedAt
        }`,
      );
      setGoogleSheetSyncMeta((current) => {
        if (!current?.sheetTitle?.trim() || !current.sheetTitleResolutionError) {
          return current;
        }
        return { ...current, sheetTitleResolutionError: null };
      });
      if (
        autoUpdateGoogleSheetRef.current &&
        googleAuthConnectedRef.current &&
        pendingSheetUpdatesRef.current.size > 0
      ) {
        allowImmediateFollowUp = true;
      }
    } catch (e) {
      const message =
        e instanceof Error ? e.message : labels.google.sheetSyncFailed;
      const retryable =
        isGoogleSheetTimeoutError(e) || isGoogleSheetNetworkIssueMessage(message);
      console.log(
        `[googleSheetAutoSync] failed name=${
          e instanceof Error ? e.name : "unknown"
        } message=${message} retryable=${retryable}`,
      );
      if (retryable) {
        const pendingCount = pendingSheetUpdatesRef.current.size;
        setPendingSheetUpdateCount(pendingCount);
        if (pendingCount === 0) {
          setSheetSyncStatus("idle");
          setSheetSyncError(null);
          setLastGoogleSheetSyncStatus(null);
          setLastGoogleSheetSyncUpdatedRows([]);
          return;
        }
        setSheetSyncStatus("pending");
        setLastGoogleSheetSyncStatus("failed");
        setLastGoogleSheetSyncUpdatedRows([]);
        setSheetSyncError(
          isGoogleSheetTimeoutError(e)
            ? labels.google.syncTimeoutRetry
            : labels.google.networkRetry,
        );
        const nextRetry = scheduleGoogleSheetNetworkRetry();
        console.log(
          `[googleSheetAutoSync] sync failed retryInMs=${nextRetry ?? "null"} error=${message}`,
        );
        return;
      }
      setSheetSyncStatus("failed");
      setLastGoogleSheetSyncStatus("failed");
      setLastGoogleSheetSyncUpdatedRows([]);
      setSheetSyncError(message);
    } finally {
      if (abortTimerId !== null) {
        window.clearTimeout(abortTimerId);
      }
      resetSheetSyncInFlight(Date.now());
      const pendingLeft = pendingSheetUpdatesRef.current.size;
      console.log(
        `[googleSheetAutoSync] flushFinally inFlight=false pendingLeft=${pendingLeft}`,
      );
      if (
        allowImmediateFollowUp &&
        pendingLeft > 0 &&
        autoUpdateGoogleSheetRef.current &&
        googleAuthConnectedRef.current &&
        !googleSheetSyncMappingIssueRef.current
      ) {
        scheduleNextGoogleSheetFlushBecausePending(
          allowImmediateFollowUp
            ? googleSheetSyncDebounceMs
            : googleSheetSyncDefaultDelayMs,
          { replaceExisting: true },
        );
      }
    }
  }, [
    buildGoogleSheetSyncPayload,
    clearScheduledSheetSyncFlush,
    labels.google,
    rememberGoogleSheetSyncDebug,
    resetSheetSyncInFlight,
    resetStaleSheetSyncInFlightIfNeeded,
    scheduleGoogleSheetNetworkRetry,
    scheduleNextGoogleSheetFlushBecausePending,
  ]);
  flushSheetSyncQueueRef.current = flushSheetSyncQueue;

  const handleSyncPendingGoogleSheetNow = useCallback(async () => {
    if (isSheetSyncFlushingRef.current) {
      const staleReset = resetStaleSheetSyncInFlightIfNeeded();
      if (!staleReset) {
        console.log("[googleSheetAutoSync] skipped because inFlight=true");
        setSheetSyncError(labels.google.syncInProgress);
        return;
      }
    }
    if (pendingSheetUpdatesRef.current.size === 0) {
      return;
    }

    clearScheduledSheetSyncFlush();
    setPendingSheetUpdateCount(pendingSheetUpdatesRef.current.size);
    setSheetSyncStatus("syncing");
    setSheetSyncError(null);
    await flushSheetSyncQueue("manual");
  }, [
    clearScheduledSheetSyncFlush,
    flushSheetSyncQueue,
    labels.google,
    resetStaleSheetSyncInFlightIfNeeded,
  ]);

  const enqueuePassedSheetRows = useCallback(
    (targets: GoogleSheetPassedRowTarget[]) => {
      const meta = googleSheetSyncMetaRef.current;
      const previewOnly = previewGoogleSheetWriteTargetsRef.current;
      if (!meta) {
        return;
      }
      if (
        !previewOnly &&
        (!autoUpdateGoogleSheetRef.current || !googleAuthConnectedRef.current)
      ) {
        return;
      }
      const writeSheetTitle = getGoogleSheetWriteSheetTitle(meta);
      const rowIndex = getOrBuildGoogleSheetImportStaircaseIndex(meta);
      const targetUnavailableReason =
        writeSheetTitle === null
          ? labels.google.sheetTabNameRequired
          : null;

      const sourceRowsById = new Map(
        meta.rows.map((row) => [row.rowId, row] as const),
      );
      const importedIndexByRowId = new Map(
        meta.rows.map((row, index) => [
          row.rowId,
          row.importedIndex ?? index,
        ] as const),
      );
      const rowsById = new Map(
        (importResultRef.current?.rows ?? []).map((row) => [row.id, row] as const),
      );
      let added = false;
      let blockedReason: string | null = null;
      let skippedNoTargetCount = 0;
      const previewLines: string[] = [];
      for (const { rowId, eventName: liveEventName } of targets) {
        const sourceRow = sourceRowsById.get(rowId);
        if (!previewOnly && syncedGoogleSheetRowIdsRef.current.has(rowId)) {
          continue;
        }
        const specRow = rowsById.get(rowId);
        const eventName =
          liveEventName ||
          sourceRow?.eventName ||
          (specRow ? getSpecRowGoogleSheetEventName(specRow) : rowId);
        const importedIndex = importedIndexByRowId.get(rowId) ?? -1;
        const pendingUpdate: PendingGoogleSheetUpdate = {
          rowId,
          matchedRowId: rowId,
          eventName,
          status: "passed",
        };
        const rowIndexTarget: GoogleSheetWriteTargetResolution =
          writeSheetTitle === null
            ? {
                rowNumber: null,
                range: null,
                source: null,
                reason: labels.google.sheetTabNameRequired,
                candidates: "",
                debugRow: null,
              }
            : resolveGoogleSheetImportStaircaseWriteTarget(pendingUpdate, {
                writeSheetTitle,
                rowIndex,
              });
        const expectedRange = rowIndexTarget.range ?? "null";
        console.log(`[googleSheetMapping] event=${eventName}`);
        console.log(`[googleSheetMapping] rowId=${rowId}`);
        console.log(`[googleSheetMapping] importedIndex=${importedIndex}`);
        console.log(
          `[googleSheetMapping] sourceRowNumber=${
            sourceRow?.sourceRowNumber ?? "null"
          }`,
        );
        console.log(
          `[googleSheetMapping] foundRowNumber=${
            rowIndexTarget.rowNumber ?? "null"
          }`,
        );
        console.log(`[googleSheetMapping] range=${expectedRange}`);
        console.log(
          `[googleSheetMapping] source=${rowIndexTarget.source ?? "none"}`,
        );
        if (rowIndexTarget.reason !== null) {
          console.warn(
            `[googleSheetMapping] blocked rowId=${rowId} reason=${rowIndexTarget.reason} candidates=${rowIndexTarget.candidates}`,
          );
        }
        const rowBlockedReason =
          targetUnavailableReason ??
          (rowIndexTarget.candidates
            ? `${rowIndexTarget.reason}; candidates=${rowIndexTarget.candidates}`
            : rowIndexTarget.reason);
        if (rowBlockedReason !== null) {
          if (
            !previewOnly &&
            targetUnavailableReason === null &&
            rowIndexTarget.reason !== null
          ) {
            const failure = recordGoogleSheetWritebackLookupFailure({
              update: pendingUpdate,
              target: {
                rowNumber: rowIndexTarget.rowNumber,
                reason: rowIndexTarget.reason,
                candidates: rowIndexTarget.candidates,
                debugRow: rowIndexTarget.debugRow,
              },
              matchedRowId: rowId,
            });
            rememberSkippedGoogleSheetWriteback(failure);
            skippedNoTargetCount += 1;
          } else {
            blockedReason = rowBlockedReason;
          }
        }
        const resolvedSourceRowNumber =
          rowIndexTarget.rowNumber ?? sourceRow?.sourceRowNumber ?? null;
        const mappingLine = `eventFromLive=${eventName} normalizedEventFromLive=${normalizeGoogleSheetEventName(eventName)} rowId=${rowId} importedIndex=${importedIndex} sourceRowNumber=${resolvedSourceRowNumber ?? "null"} matchedGoogleRow=${rowIndexTarget.rowNumber ?? "null"} range=${expectedRange} leaf=${
          rowIndexTarget.debugRow?.leaf ?? rowIndexTarget.rowNumber !== null
        } parent=${rowIndexTarget.debugRow?.parent ?? false} gValue=${
          rowIndexTarget.debugRow?.gValue || "null"
        } gIsBooleanLike=${
          rowIndexTarget.debugRow?.gIsBooleanLike ?? false
        } source=${rowIndexTarget.source ?? "none"}${
          rowBlockedReason ? ` skippedReason=${rowBlockedReason}` : " skippedReason=null"
        }`;
        previewLines.push(`${eventName} -> ${
          rowIndexTarget.rowNumber ?? "null"
        } -> ${expectedRange} -> leaf=${
          rowIndexTarget.debugRow?.leaf ?? rowIndexTarget.rowNumber !== null
        } -> parent=${rowIndexTarget.debugRow?.parent ?? false} -> gValue=${
          rowIndexTarget.debugRow?.gValue || "null"
        } -> gIsBooleanLike=${
          rowIndexTarget.debugRow?.gIsBooleanLike ?? false
        } -> source=${rowIndexTarget.source ?? "none"}${
          rowBlockedReason ? ` (blocked: ${rowBlockedReason})` : ""
        }`);
        if (expectedRange !== "null") {
          setLastGoogleSheetTargetRange(expectedRange);
        }
        setLastGoogleSheetMappingDebugInfo((current) =>
          [mappingLine, ...(current?.split("\n") ?? [])].slice(0, 5).join("\n"),
        );
        if (previewOnly || rowBlockedReason !== null) {
          continue;
        }
        forgetSkippedGoogleSheetWriteback(rowId);
        pendingSheetUpdatesRef.current.set(rowId, {
          ...pendingUpdate,
          sourceRowNumber: rowIndexTarget.rowNumber,
          range: rowIndexTarget.range,
          source: rowIndexTarget.source ?? undefined,
        });
        console.log(
          `[googleSheetAutoSync] queued event=${eventName} range=${expectedRange}`,
        );
        added = true;
      }

      if (previewLines.length > 0) {
        setGoogleSheetWriteTargetPreview((current) =>
          [...previewLines, ...current].slice(0, 10),
        );
      }

      if (previewOnly) {
        setSheetSyncStatus("idle");
        setSheetSyncError(labels.google.previewNoWrites);
        return;
      }

      if (blockedReason !== null) {
        setSheetSyncStatus("failed");
        setSheetSyncError(`Writeback blocked: ${blockedReason}`);
      }

      if (!added) {
        if (skippedNoTargetCount > 0) {
          setSheetSyncStatus("idle");
          setSheetSyncError(labels.google.noCheckboxRowsForPendingEvents);
        }
        return;
      }
      setPendingSheetUpdateCount(pendingSheetUpdatesRef.current.size);
      setSheetSyncStatus("pending");
      setSheetSyncError(
        skippedNoTargetCount > 0
          ? labels.google.skippedEventsWithoutCheckboxRow(skippedNoTargetCount)
          : null,
      );
      if (isSheetSyncFlushingRef.current) {
        console.log("[googleSheetAutoSync] inFlight=true; queued only");
        return;
      }
      const scheduled = scheduleSheetSyncFlush(googleSheetSyncDebounceMs, {
        replaceExisting: true,
      });
      if (scheduled) {
        console.log(
          `[googleSheetAutoSync] debounce scheduled ms=${googleSheetSyncDebounceMs} pending=${pendingSheetUpdatesRef.current.size}`,
        );
      }
    },
    [
      forgetSkippedGoogleSheetWriteback,
      getOrBuildGoogleSheetImportStaircaseIndex,
      labels.google,
      recordGoogleSheetWritebackLookupFailure,
      rememberSkippedGoogleSheetWriteback,
      scheduleSheetSyncFlush,
    ],
  );

  useEffect(() => {
    if (
      previewGoogleSheetWriteTargets &&
      googleAuthStatus.connected &&
      googleSheetSyncMeta
    ) {
      getOrBuildGoogleSheetImportStaircaseIndex(googleSheetSyncMeta);
    }
  }, [
    getOrBuildGoogleSheetImportStaircaseIndex,
    googleAuthStatus.connected,
    googleSheetSyncMeta,
    previewGoogleSheetWriteTargets,
  ]);

  useEffect(() => {
    if (!previewGoogleSheetWriteTargets || !matchBundle) {
      return;
    }
    const targets = matchBundle.logs
      .filter((log) => log.matchType === "passed" && log.matchedRowId)
      .slice(-10)
      .map((log) => ({
        rowId: log.matchedRowId as string,
        eventName: getPassedLogGoogleSheetEventName(log),
      }));
    if (targets.length > 0) {
      enqueuePassedSheetRows(targets);
    }
  }, [enqueuePassedSheetRows, matchBundle, previewGoogleSheetWriteTargets]);

  useEffect(() => {
    if (!matchBundle) {
      return;
    }
    if (!autoUpdateGoogleSheet || previewGoogleSheetWriteTargets) {
      return;
    }
    const targets: GoogleSheetPassedRowTarget[] = [];
    for (const log of matchBundle.logs) {
      if (sheetSyncSeenLogIdsRef.current.has(log.id)) {
        continue;
      }
      sheetSyncSeenLogIdsRef.current.add(log.id);
      if (log.matchType === "unknown") {
        console.log(
          `[googleSheetAutoSync] skipUnknown event=${getUnknownLogEventName(log)}`,
        );
        continue;
      }
      if (log.matchType === "passed" && log.matchedRowId) {
        targets.push({
          rowId: log.matchedRowId,
          eventName: getPassedLogGoogleSheetEventName(log),
        });
      }
    }
    if (targets.length > 0) {
      enqueuePassedSheetRows(targets);
    }
  }, [
    autoUpdateGoogleSheet,
    enqueuePassedSheetRows,
    matchBundle,
    previewGoogleSheetWriteTargets,
  ]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      if (previewGoogleSheetWriteTargetsRef.current) {
        return;
      }
      const payload = buildGoogleSheetSyncPayload();
      if (!payload || !googleAuthConnectedRef.current) {
        return;
      }
      void fetch("/api/google-sheet/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      });
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [buildGoogleSheetSyncPayload]);

  useEffect(() => {
    if (!googleAuthStatus.connected || !googleSheetSyncMeta) {
      return;
    }

    const spreadsheetId = googleSheetSyncMeta.spreadsheetId.trim();
    const gid = googleSheetSyncMeta.gid.trim();
    if (!spreadsheetId || !gid) {
      return;
    }

    const sheetTitleSource = getGoogleSheetTitleSource(googleSheetSyncMeta);
    const currentWriteTitle = getGoogleSheetWriteSheetTitle(googleSheetSyncMeta);
    if (sheetTitleSource === "manual") {
      clearScheduledGoogleSheetTitleResolve();
      googleSheetTitleRetryAttemptRef.current = 0;
      console.log(
        `[googleSheetTitle] usingManualTitle title=${
          currentWriteTitle ?? "null"
        }`,
      );
      if (
        currentWriteTitle &&
        googleAuthConnectedRef.current &&
        !isGoogleSheetRowIndexReadyForMeta(
          googleSheetRowIndexRef.current,
          googleSheetSyncMeta,
        )
      ) {
        getOrBuildGoogleSheetImportStaircaseIndex(googleSheetSyncMeta);
      }
      return;
    }

    if (
      sheetTitleSource === "auto-detected" &&
      isResolvedGoogleSheetTitle(googleSheetSyncMeta.sheetTitle)
    ) {
      clearScheduledGoogleSheetTitleResolve();
      googleSheetTitleRetryAttemptRef.current = 0;
      if (googleSheetSyncMeta.sheetTitleResolutionError?.trim()) {
        setGoogleSheetSyncMeta((current) => {
          if (
            !current ||
            current.spreadsheetId !== spreadsheetId ||
            current.gid !== gid
          ) {
            return current;
          }
          return { ...current, sheetTitleResolutionError: null };
        });
      }
      if (
        googleAuthConnectedRef.current &&
        !isGoogleSheetRowIndexReadyForMeta(
          googleSheetRowIndexRef.current,
          googleSheetSyncMeta,
        )
      ) {
        getOrBuildGoogleSheetImportStaircaseIndex(googleSheetSyncMeta);
      }
      return;
    }

    const resolveKey = `${spreadsheetId}\0${gid}`;
    if (sheetTitleResolveKeyRef.current === resolveKey) {
      return;
    }
    sheetTitleResolveKeyRef.current = resolveKey;

    let cancelled = false;
    const resolveSheetTitle = async () => {
      try {
        console.log(`[googleSheetTitle] resolveStart gid=${gid}`);
        const response = await fetch("/api/google-sheet/title", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ spreadsheetId, gid }),
        });
        const result = (await response.json().catch(() => null)) as
          | {
              success?: boolean;
              sheetTitle?: unknown;
              error?: string;
              technicalDetail?: string;
              networkIssue?: boolean;
            }
          | null;
        if (!response.ok || !result?.success) {
          const error = result?.error ?? unresolvedGoogleSheetTabMessage(gid);
          const detail = result?.technicalDetail?.trim();
          const titleError = new Error(
            detail ? `${error} ${detail}` : error,
          ) as Error & { networkIssue?: boolean; status?: number };
          titleError.networkIssue =
            Boolean(result?.networkIssue) || response.status === 503;
          titleError.status = response.status;
          throw titleError;
        }
        if (typeof result.sheetTitle !== "string" || !result.sheetTitle.trim()) {
          throw new Error(unresolvedGoogleSheetTabMessage(gid));
        }
        if (cancelled) {
          return;
        }
        const sheetTitle = result.sheetTitle.trim();
        const nextMetaForIndex = withGoogleSheetTitle(
          googleSheetSyncMeta,
          sheetTitle,
          "auto-detected",
        );
        googleSheetTitleRetryAttemptRef.current = 0;
        clearScheduledGoogleSheetTitleResolve();
        setManualSheetTitleInput(sheetTitle);
        setGoogleSheetImportInfo(labels.google.sheetTabDetectedAutomatically);
        manualGoogleSheetSyncSettingsRef.current = {
          ...manualGoogleSheetSyncSettingsRef.current,
          tabKey:
            getGoogleSheetTabKey(nextMetaForIndex) ??
            manualGoogleSheetSyncSettingsRef.current.tabKey,
          manualSheetTitle: sheetTitle,
          sheetTitleSource: "auto-detected",
        };
        setGoogleSheetSyncMeta((current) => {
          if (
            !current ||
            current.spreadsheetId !== spreadsheetId ||
            current.gid !== gid
          ) {
            return current;
          }
          const nextMeta = withGoogleSheetTitle(
            current,
            sheetTitle,
            "auto-detected",
          );
          googleSheetSyncMetaRef.current = nextMeta;
          return nextMeta;
        });
        googleSheetSyncMetaRef.current = nextMetaForIndex;
        if (
          googleAuthConnectedRef.current &&
          !isGoogleSheetRowIndexReadyForMeta(
            googleSheetRowIndexRef.current,
            nextMetaForIndex,
          )
        ) {
          getOrBuildGoogleSheetImportStaircaseIndex(nextMetaForIndex);
        }
        if (
          autoUpdateGoogleSheetRef.current &&
          googleAuthConnectedRef.current &&
          pendingSheetUpdatesRef.current.size > 0
        ) {
          setSheetSyncStatus("pending");
          scheduleSheetSyncFlush(googleSheetSyncDefaultDelayMs, {
            replaceExisting: true,
          });
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        const message =
          error instanceof Error
            ? error.message
            : unresolvedGoogleSheetTabMessage(gid);
        const fallbackManualTitle = getGoogleSheetWriteSheetTitle(
          googleSheetSyncMetaRef.current,
        );
        const isNetworkIssue =
          Boolean((error as { networkIssue?: boolean } | null)?.networkIssue) ||
          isGoogleSheetNetworkIssueMessage(message);
        if (isNetworkIssue) {
          console.log(
            `[googleSheetTitle] resolveNetworkIssue fallbackManualTitle=${
              fallbackManualTitle ?? "null"
            }`,
          );
        }
        setGoogleSheetSyncMeta((current) => {
          if (
            !current ||
            current.spreadsheetId !== spreadsheetId ||
            current.gid !== gid
          ) {
            return current;
          }
          return { ...current, sheetTitleResolutionError: message };
        });
        setLastGoogleSheetMappingDebugInfo((current) =>
          [
            `Google Sheet title warning: ${message}`,
            ...(fallbackManualTitle
              ? [`Using manual title: ${fallbackManualTitle}`]
              : []),
            ...(current?.split("\n") ?? []),
          ]
            .slice(0, 5)
            .join("\n"),
        );
        if (fallbackManualTitle) {
          console.log(
            `[googleSheetTitle] usingManualTitle title=${fallbackManualTitle}`,
          );
          getOrBuildGoogleSheetImportStaircaseIndex(
            googleSheetSyncMetaRef.current,
          );
          return;
        }
        if (isNetworkIssue && googleSheetTitleRetryTimerRef.current === null) {
          const retryDelayMs = getGoogleSheetSyncRetryDelayMs(
            googleSheetTitleRetryAttemptRef.current,
          );
          googleSheetTitleRetryAttemptRef.current += 1;
          googleSheetTitleRetryTimerRef.current = window.setTimeout(() => {
            googleSheetTitleRetryTimerRef.current = null;
            sheetTitleResolveKeyRef.current = null;
            void resolveSheetTitle();
          }, retryDelayMs);
          if (pendingSheetUpdatesRef.current.size > 0) {
            setSheetSyncStatus("pending");
            setSheetSyncError(`${labels.google.networkRetry} (Google Sheet title)`);
          }
        }
      }
    };

    void resolveSheetTitle();
    return () => {
      cancelled = true;
    };
  }, [
    clearScheduledGoogleSheetTitleResolve,
    googleAuthStatus.connected,
    googleSheetSyncMeta,
    labels.google.networkRetry,
    labels.google.sheetTabDetectedAutomatically,
    getOrBuildGoogleSheetImportStaircaseIndex,
    scheduleSheetSyncFlush,
  ]);

  const autoUpdateGoogleSheetDisabledReason =
    useMemo<AutoUpdateGoogleSheetDisabledReason | null>(() => {
      if (
        !googleSheetSyncMeta ||
        googleSheetSourceUrl === null ||
        !googleSheetSyncMeta.spreadsheetId.trim()
      ) {
        return labels.google.importFirst;
      }

      if (!googleAuthStatus.connected) {
        return labels.google.connectGoogleFirst;
      }

      if (getGoogleSheetWriteSheetTitle(googleSheetSyncMeta) === null) {
        return labels.google.sheetTabNameRequired;
      }

      if (
        !isGoogleSheetRowIndexReadyForMeta(
          googleSheetRowIndex,
          googleSheetSyncMeta,
        )
      ) {
        return googleSheetSyncMeta.writebackSource === "uploadedXlsx"
          ? labels.google.xlsxEventIndexNotBuilt
          : labels.google.googleRowIndexNotBuilt;
      }

      if (
        !isGoogleSheetRowBindingReady(
          googleSheetSyncMeta,
          googleSheetRowIndex,
          importResult,
        )
      ) {
        return googleSheetSyncMeta.writebackSource === "uploadedXlsx"
          ? labels.google.xlsxEventIndexNotBuilt
          : labels.google.missingSourceRowMapping;
      }

      return null;
    }, [
      googleAuthStatus.connected,
      googleSheetRowIndex,
      googleSheetSourceUrl,
      googleSheetSyncMeta,
      importResult,
      labels.google,
    ]);
  const autoUpdateGoogleSheetValidationMessage =
    autoUpdateAttemptedWithoutRequirements
      ? autoUpdateGoogleSheetDisabledReason
      : null;
  const syncPendingNowDisabledReason = useMemo(() => {
    if (pendingSheetUpdateCount <= 0) {
      return labels.google.noPendingUpdates;
    }
    if (sheetSyncInFlight) {
      return labels.google.syncInProgress;
    }
    if (!googleAuthStatus.connected) {
      return labels.google.googleNotConnected;
    }
    if (!googleSheetSyncMeta || googleSheetSourceUrl === null) {
      return labels.google.importFirst;
    }
    return autoUpdateGoogleSheetDisabledReason;
  }, [
    autoUpdateGoogleSheetDisabledReason,
    googleAuthStatus.connected,
    googleSheetSourceUrl,
    googleSheetSyncMeta,
    labels.google,
    pendingSheetUpdateCount,
    sheetSyncInFlight,
  ]);
  const currentSheetSyncStatus: SheetSyncStatus = sheetSyncInFlight
    ? "syncing"
    : sheetSyncStatus;

  useEffect(() => {
    if (
      !autoUpdateAttemptedWithoutRequirements ||
      autoUpdateGoogleSheetDisabledReason !== null
    ) {
      return;
    }
    setAutoUpdateAttemptedWithoutRequirements(false);
  }, [
    autoUpdateAttemptedWithoutRequirements,
    autoUpdateGoogleSheetDisabledReason,
  ]);

  useEffect(() => {
    if (
      !googleSheetSyncMeta ||
      !googleSheetSyncMeta.sheetTitle?.trim() ||
      !googleSheetSyncMeta.sheetTitleResolutionError ||
      getGoogleSheetTitleSource(googleSheetSyncMeta) !== "auto-detected"
    ) {
      return;
    }

    setGoogleSheetSyncMeta((current) => {
      if (!current?.sheetTitle?.trim() || !current.sheetTitleResolutionError) {
        return current;
      }
      return { ...current, sheetTitleResolutionError: null };
    });
  }, [googleSheetSyncMeta]);

  const googleSheetDebugDetails = useMemo(() => {
    const meta = googleSheetSyncMeta;
    const checkboxColumnIndex = getSelectedGoogleSheetCheckboxColumnIndex(
      meta,
      manualCheckboxColumnInput,
    );
    const checkboxColumnSource = getGoogleSheetCheckboxColumnSource(
      meta,
      manualCheckboxColumnInput,
    );
    const lastSyncError =
      !sheetSyncInFlight && lastGoogleSheetSyncStatus === "failed"
        ? sheetSyncError?.trim() || null
        : null;
    const googleRowIndexBuilt =
      googleSheetRowIndex !== null && googleSheetRowIndex.indexedEventCount > 0;
    const writeSheetTitle = getGoogleSheetWriteSheetTitle(meta);
    const rowIndexSample = googleRowIndexDiagnosticEvents
      .map((eventName) =>
        formatGoogleSheetRowIndexDebugLine(googleSheetRowIndex, eventName, {
          checkboxColumnIndex,
          writeSheetTitle,
        }),
      )
      .join("\n  ");
    const skippedWritebacksSample = skippedGoogleSheetWritebacks
      .slice(0, 10)
      .map((skipped) => `${skipped.eventName} -> ${skipped.reason}`)
      .join("\n  ");
    const rowBindingSource = getGoogleSheetRowBindingSource(meta);
    const rowBindingReady = isGoogleSheetRowBindingReady(
      meta,
      googleSheetRowIndex,
      importResult,
    );
    const firstIndexedEvents =
      googleSheetRowIndex?.entries
        .slice(0, 10)
        .map(
          (entry) =>
            `${entry.eventName || entry.normalizedEventName} -> ${
              entry.rowNumbers[0] ?? "null"
            }`,
        )
        .join("\n  ") ?? "";
    const lastResolvedWriteback =
      lastGoogleSheetMappingDebugInfo?.split("\n")[0] ?? "null";
    const detectedParser =
      meta?.detectedParser ??
      (typeof importResult?.debug.detectedParser === "string"
        ? importResult.debug.detectedParser
        : null);
    const detectedColumns =
      meta?.detectedColumns ??
      (typeof importResult?.debug.detectedColumns === "string"
        ? importResult.debug.detectedColumns
        : null);
    const importedSpecRowsCount =
      meta?.importedSpecRowsCount ?? importResult?.rows.length ?? 0;
    const debugNumber = (key: string): number | null => {
      const value = importResult?.debug[key];
      return typeof value === "number" && Number.isFinite(value)
        ? value
        : null;
    };
    const importFetchMs = meta?.importFetchMs ?? debugNumber("importFetchMs");
    const importParseMs = meta?.importParseMs ?? debugNumber("importParseMs");
    const importTotalMs = meta?.importTotalMs ?? debugNumber("importTotalMs");
    const googleRowsRead = meta?.googleRowsRead ?? debugNumber("googleRowsRead");
    const effectiveRowsParsed =
      meta?.effectiveRowsParsed ?? debugNumber("effectiveRowsParsed");
    const firstParsedEventsFromImport =
      importResult?.rows
        .slice(0, 10)
        .map((row) => getSpecRowGoogleSheetEventName(row))
        .filter(Boolean) ?? [];
    const firstParsedEventsSample = (
      meta?.firstParsedEvents && meta.firstParsedEvents.length > 0
        ? meta.firstParsedEvents
        : firstParsedEventsFromImport
    )
      .slice(0, 10)
      .join("\n  ");
    return [
      `appVersion=${appBuildInfo.version}`,
      `buildTimestamp=${appBuildInfo.timestamp}`,
      `gitCommit=${appBuildInfo.gitCommit}`,
      `gitDirty=${appBuildInfo.gitDirty}`,
      `selectedPlatform=${activePlatform}`,
      `unityLiveStatus=${unityLiveStatus}`,
      `unityLogPath=${unityLogPath.trim() || "%LOCALAPPDATA%\\Unity\\Editor\\Editor.log"}`,
      `unityResolvedLogPath=${unityResolvedLogPath ?? "null"}`,
      `unityLogFileName=${unityLogFileName ?? "null"}`,
      `unityLogSourceType=${unityLogSourceType}`,
      `unityDetectedProjectPath=${unityDetectedProjectPath ?? "null"}`,
      `unityDetectedProductName=${unityDetectedProductName ?? "null"}`,
      `unityLogFileExists=${unityLogFileExists ?? "null"}`,
      `unityWatcherStarted=${unityWatcherStarted}`,
      `unityLastError=${unityLastError ?? unityLiveError ?? "null"}`,
      `unityLastLineAt=${unityLastLineAt ?? "null"}`,
      `unityAnalyticsEventsSeenCount=${unityAnalyticsEventsSeenCount}`,
      `unityShowAllLogLines=${unityShowAllLogLines}`,
      `unityInitialTailRead=${unityInitialTailRead}`,
      `unityInitialTailLinesCount=${unityInitialTailLinesCount}`,
      `unityRawLinesSeenCount=${unityRawLinesSeenCount}`,
      `unityAnalyticsCandidateLinesCount=${unityAnalyticsCandidateLinesCount}`,
      `unityLastRawLine=${unityLastRawLine ?? "null"}`,
      `unityLastExtractedEvent=${unityLastExtractedEvent ?? "null"}`,
      `unityLastExtractedAnalyticsType=${unityLastExtractedAnalyticsType ?? "null"}`,
      `iosLunarRawLinesCount=${iosLunarRawLinesCount}`,
      `iosLunarAnalyticsCandidateLinesCount=${iosLunarAnalyticsCandidateLinesCount}`,
      `iosLunarLastRawLine=${iosLunarLastRawLine ?? "null"}`,
      `iosLunarLastExtractedEvent=${iosLunarLastExtractedEvent ?? "null"}`,
      `iosLunarLastExtractedAnalyticsType=${iosLunarLastExtractedAnalyticsType ?? "null"}`,
      `iosLunarImportSource=${iosLunarImportSource ?? "null"}`,
      `unityTailMode=${unityTailMode ?? "null"}`,
      `unityLastRawLineAt=${unityLastRawLineAt ?? "null"}`,
      `detectedParser=${detectedParser ?? "null"}`,
      `detectedColumns=${detectedColumns ?? "null"}`,
      `checkboxColumn=${meta?.checkboxColumn ?? fixedGoogleSheetCheckboxColumnLetter}`,
      `descriptionColumn=${meta?.descriptionColumn ?? "null"}`,
      `parameterDescriptionColumn=${meta?.parameterDescriptionColumn ?? "null"}`,
      `importFetchMs=${importFetchMs ?? "null"}`,
      `importParseMs=${importParseMs ?? "null"}`,
      `importTotalMs=${importTotalMs ?? "null"}`,
      `googleRowsRead=${googleRowsRead ?? "null"}`,
      `effectiveRowsParsed=${effectiveRowsParsed ?? "null"}`,
      `importedSpecRowsCount=${importedSpecRowsCount}`,
      `firstParsedEvents:\n  ${firstParsedEventsSample || "null"}`,
      `spreadsheetId=${meta?.spreadsheetId.trim() || "null"}`,
      `gid=${meta?.gid.trim() || "null"}`,
      `sheetTitleSource=${getGoogleSheetTitleSource(meta) ?? "null"}`,
      `resolvedSheetTitle=${meta?.sheetTitle?.trim() || "null"}`,
      `manualSheetTitle=${meta?.manualSheetTitle?.trim() || "null"}`,
      `sheetTitleResolutionError=${
        meta?.sheetTitleResolutionError?.trim() || "null"
      }`,
      `googleSheetTitleWarning=${
        meta?.sheetTitleResolutionError?.trim()
          ? `Title resolve failed; using manual title ${getGoogleSheetWriteSheetTitle(meta) ?? "null"}`
          : "null"
      }`,
      `importErrorType=${
        googleSheetImportErrorDebug?.importErrorType ?? "null"
      }`,
      `importTechnicalDetail=${
        googleSheetImportErrorDebug?.importTechnicalDetail ?? "null"
      }`,
      `importRetryInSeconds=${nextGoogleSheetImportRetrySeconds ?? "null"}`,
      `selectedWorksheet=${
        googleSheetRowIndex?.sheetTitle ??
        getGoogleSheetWriteSheetTitle(meta) ??
        "null"
      }`,
      `checkboxColumn=${columnIndexToA1(checkboxColumnIndex)}`,
      `checkboxColumnIndex=${checkboxColumnIndex ?? "null"}`,
      `checkboxSource=${checkboxColumnSource}`,
      "writeMode=A1 batchUpdate",
      `pendingSheetUpdatesCount=${pendingSheetUpdateCount}`,
      `syncInFlight=${sheetSyncInFlight}`,
      `currentSyncStatus=${currentSheetSyncStatus}`,
      `syncStartedAt=${sheetSyncStartedAt ?? "null"}`,
      `syncDurationSec=${
        sheetSyncStartedAt !== null
          ? Math.max(0, Math.round((Date.now() - sheetSyncStartedAt) / 1000))
          : "null"
      }`,
      `lastSyncAttemptAt=${lastSheetSyncAttemptAt ?? "null"}`,
      `lastSyncFinishedAt=${lastSheetSyncFinishedAt ?? "null"}`,
      `nextRetryInSec=${nextSheetSyncRetrySeconds ?? "null"}`,
      `googleRowIndexSheetTitle=${googleSheetRowIndex?.sheetTitle ?? "null"}`,
      `googleRowIndexRowsRead=${googleSheetRowIndex?.rowCount ?? "null"}`,
      `googleRowIndexCacheVersion=${
        googleSheetRowIndex?.cacheVersion ?? "null"
      }`,
      `googleRowIndexSize=${googleSheetRowIndex?.indexedEventCount ?? "null"}`,
      `googleRowIndexStatus=${
        googleRowIndexBuilt ? "ready" : "Google row index not built"
      }`,
      `rowIndexStatus=${googleRowIndexStatus}`,
      `rowIndexMappedEventsCount=${
        googleSheetRowIndex?.indexedEventCount ?? 0
      }`,
      `writebackSource=${meta?.writebackSource ?? "googleSheetImport"}`,
      `rowBindingSource=${rowBindingSource}`,
      `rowBindingReady=${rowBindingReady}`,
      `writebackIndexSource=${googleSheetRowIndex?.source ?? "none"}`,
      `importStaircaseIndexSize=${googleSheetRowIndex?.indexedEventCount ?? 0}`,
      `firstIndexedEvents:\n  ${firstIndexedEvents || "null"}`,
      `xlsxImportDebug:\n  ${
        lastXlsxImportDebugInfo?.split("\n").join("\n  ") || "null"
      }`,
      `rowIndexLastError=${googleRowIndexLastError ?? "null"}`,
      `rowIndexSample:\n  ${rowIndexSample || "null"}`,
      `googleRowIndexRetryInSeconds=${nextGoogleRowIndexRetrySeconds ?? "null"}`,
      `lastWritebackLookupFailedEvent=${
        lastWritebackLookupFailure?.eventName ?? "null"
      }`,
      `lastWritebackLookupFailedNormalizedEvent=${
        lastWritebackLookupFailure?.normalizedEventName ?? "null"
      }`,
      `lastWritebackLookupFailedRowId=${
        lastWritebackLookupFailure?.rowId ?? "null"
      }`,
      `lastWritebackLookupFailedReason=${
        lastWritebackLookupFailure?.reason ?? "null"
      }`,
      `skippedEventsWithoutCheckboxRow=${skippedGoogleSheetWritebacks.length}`,
      `skippedWritebacks:\n  ${skippedWritebacksSample || "null"}`,
      `lastWritebackMapping:\n  ${
        lastGoogleSheetMappingDebugInfo
          ?.split("\n")
          .join("\n  ") || "null"
      }`,
      `lastResolvedWriteback:\n  ${lastResolvedWriteback}`,
      `lastSyncRanges=${
        lastGoogleSheetSyncRanges.length > 0
          ? lastGoogleSheetSyncRanges.join(", ")
          : "[]"
      }`,
      `lastSyncRequestRanges=${
        lastGoogleSheetSyncRanges.length > 0
          ? lastGoogleSheetSyncRanges.join(", ")
          : "[]"
      }`,
      `lastSyncUpdatedRowIds=${
        lastGoogleSheetSyncUpdatedRows.length > 0
          ? lastGoogleSheetSyncUpdatedRows.slice(-5).join(", ")
          : "[]"
      }`,
      `lastSyncError=${lastSyncError ?? "null"}`,
      `lastSyncStatus=${currentSheetSyncStatus}`,
      `lastCompletedSyncStatus=${lastGoogleSheetSyncStatus ?? "null"}`,
      `syncPendingNowDisabledReason=${syncPendingNowDisabledReason ?? "null"}`,
      `apiStatus=${lastGoogleSheetSyncApiStatus ?? "null"}`,
      `totalUpdatedCells=${lastGoogleSheetSyncTotalUpdatedCells ?? "null"}`,
      `totalUpdatedRows=${lastGoogleSheetSyncTotalUpdatedRows ?? "null"}`,
    ].join("\n");
  }, [
    activePlatform,
    googleSheetRowIndex,
    googleSheetImportErrorDebug,
    googleSheetSyncMeta,
    googleRowIndexLastError,
    googleRowIndexStatus,
    importResult,
    currentSheetSyncStatus,
    lastSheetSyncAttemptAt,
    lastSheetSyncFinishedAt,
    lastGoogleSheetSyncApiStatus,
    lastGoogleSheetSyncRanges,
    lastGoogleSheetSyncStatus,
    lastGoogleSheetMappingDebugInfo,
    lastGoogleSheetSyncTotalUpdatedCells,
    lastGoogleSheetSyncTotalUpdatedRows,
    lastGoogleSheetSyncUpdatedRows,
    lastWritebackLookupFailure,
    manualCheckboxColumnInput,
    nextGoogleRowIndexRetrySeconds,
    nextGoogleSheetImportRetrySeconds,
    nextSheetSyncRetrySeconds,
    pendingSheetUpdateCount,
    sheetSyncError,
    sheetSyncInFlight,
    sheetSyncStartedAt,
    skippedGoogleSheetWritebacks,
    syncPendingNowDisabledReason,
    unityAnalyticsEventsSeenCount,
    unityLastError,
    unityLastLineAt,
    unityLiveError,
    unityLiveStatus,
    unityLogFileExists,
    unityLogFileName,
    unityLogSourceType,
    unityDetectedProjectPath,
    unityDetectedProductName,
    unityLogPath,
    unityLastRawLineAt,
    unityInitialTailRead,
    unityInitialTailLinesCount,
    unityLastRawLine,
    unityLastExtractedEvent,
    unityLastExtractedAnalyticsType,
    unityTailMode,
    unityRawLinesSeenCount,
    unityResolvedLogPath,
    unityShowAllLogLines,
    unityAnalyticsCandidateLinesCount,
    unityWatcherStarted,
    iosLunarRawLinesCount,
    iosLunarAnalyticsCandidateLinesCount,
    iosLunarLastRawLine,
    iosLunarLastExtractedEvent,
    iosLunarLastExtractedAnalyticsType,
    iosLunarImportSource,
  ]);

  useEffect(() => {
    if (!autoUpdateGoogleSheet || autoUpdateGoogleSheetDisabledReason === null) {
      return;
    }

    setAutoUpdateGoogleSheet(false);
    autoUpdateGoogleSheetRef.current = false;
    sheetSyncRetryAttemptRef.current = 0;
    clearScheduledSheetSyncFlush();
    clearScheduledGoogleRowIndexRebuild();
    clearScheduledGoogleSheetTitleResolve();
    googleSheetRowIndexRetryAttemptRef.current = 0;
    googleSheetTitleRetryAttemptRef.current = 0;
    googleSheetRowIndexNetworkIssueRef.current = false;
    setPendingSheetUpdateCount(pendingSheetUpdatesRef.current.size);
    setSheetSyncStatus(
      pendingSheetUpdatesRef.current.size > 0 ? "pending" : "idle",
    );
    setSheetSyncError(null);
  }, [
    autoUpdateGoogleSheet,
    autoUpdateGoogleSheetDisabledReason,
    clearScheduledGoogleRowIndexRebuild,
    clearScheduledGoogleSheetTitleResolve,
    clearScheduledSheetSyncFlush,
  ]);

  const handleAutoUpdateGoogleSheetChange = useCallback(
    (enabled: boolean) => {
      if (enabled && autoUpdateGoogleSheetDisabledReason !== null) {
        setAutoUpdateGoogleSheet(false);
        autoUpdateGoogleSheetRef.current = false;
        setAutoUpdateAttemptedWithoutRequirements(true);
        setPendingSheetUpdateCount(pendingSheetUpdatesRef.current.size);
        setSheetSyncStatus(
          pendingSheetUpdatesRef.current.size > 0 ? "pending" : "idle",
        );
        setSheetSyncError(null);
        return;
      }

      setAutoUpdateAttemptedWithoutRequirements(false);
      setAutoUpdateGoogleSheet(enabled);
      autoUpdateGoogleSheetRef.current = enabled;
      if (!enabled) {
        sheetSyncRetryAttemptRef.current = 0;
        clearScheduledSheetSyncFlush();
        clearScheduledGoogleRowIndexRebuild();
        clearScheduledGoogleSheetTitleResolve();
        googleSheetRowIndexRetryAttemptRef.current = 0;
        googleSheetTitleRetryAttemptRef.current = 0;
        googleSheetRowIndexNetworkIssueRef.current = false;
        setPendingSheetUpdateCount(pendingSheetUpdatesRef.current.size);
        setSheetSyncStatus(
          pendingSheetUpdatesRef.current.size > 0 ? "pending" : "idle",
        );
        return;
      }
      clearGoogleSheetSyncErrorState();
      if (!googleAuthConnectedRef.current) {
        setAutoUpdateGoogleSheet(false);
        autoUpdateGoogleSheetRef.current = false;
        setAutoUpdateAttemptedWithoutRequirements(true);
        setSheetSyncError(null);
        return;
      }
      sheetSyncRetryAttemptRef.current = 0;
      getOrBuildGoogleSheetImportStaircaseIndex(googleSheetSyncMetaRef.current);
      if (pendingSheetUpdatesRef.current.size > 0) {
        setSheetSyncStatus("pending");
        scheduleSheetSyncFlush(googleSheetSyncDefaultDelayMs, {
          replaceExisting: true,
        });
      }
    },
    [
      autoUpdateGoogleSheetDisabledReason,
      clearScheduledGoogleRowIndexRebuild,
      clearScheduledGoogleSheetTitleResolve,
      clearScheduledSheetSyncFlush,
      clearGoogleSheetSyncErrorState,
      getOrBuildGoogleSheetImportStaircaseIndex,
      scheduleSheetSyncFlush,
    ],
  );

  useEffect(() => {
    if (pendingSheetUpdateCount !== 0) {
      return;
    }

    sheetSyncRetryAttemptRef.current = 0;
    const isNetworkSyncError =
      isGoogleSheetNetworkIssueMessage(sheetSyncError) ||
      sheetSyncError === labels.google.networkRetry ||
      sheetSyncError === labels.google.syncTimeoutRetry ||
      Boolean(sheetSyncError?.startsWith(labels.google.networkRetry)) ||
      Boolean(sheetSyncError?.startsWith(labels.google.syncTimeoutRetry));
    if (
      (sheetSyncStatus === "pending" || isNetworkSyncError) &&
      !googleSheetRowIndexNetworkIssueRef.current
    ) {
      setSheetSyncStatus("idle");
      setSheetSyncError(null);
      setLastGoogleSheetSyncStatus(null);
      setLastGoogleSheetSyncUpdatedRows([]);
      clearScheduledSheetSyncFlush();
    }
  }, [
    clearScheduledSheetSyncFlush,
    labels.google.networkRetry,
    labels.google.syncTimeoutRetry,
    pendingSheetUpdateCount,
    sheetSyncError,
    sheetSyncStatus,
  ]);

  useEffect(() => {
    if (
      !autoUpdateGoogleSheet ||
      autoUpdateGoogleSheetDisabledReason !== null ||
      !googleAuthStatus.connected ||
      pendingSheetUpdateCount <= 0 ||
      sheetSyncTimerRef.current !== null ||
      isSheetSyncFlushingRef.current
    ) {
      return;
    }

    setSheetSyncStatus("pending");
    const hasNetworkWarning =
      isGoogleSheetNetworkIssueMessage(sheetSyncError) ||
      sheetSyncError === labels.google.networkRetry ||
      sheetSyncError === labels.google.syncTimeoutRetry ||
      Boolean(sheetSyncError?.startsWith(labels.google.networkRetry)) ||
      Boolean(sheetSyncError?.startsWith(labels.google.syncTimeoutRetry));
    if (hasNetworkWarning) {
      setSheetSyncError(
        labels.google.networkRetry,
      );
      scheduleGoogleSheetNetworkRetry();
      return;
    }
    getOrBuildGoogleSheetImportStaircaseIndex(googleSheetSyncMetaRef.current);
    scheduleSheetSyncFlush(googleSheetSyncDefaultDelayMs, {
      replaceExisting: true,
    });
  }, [
    autoUpdateGoogleSheet,
    autoUpdateGoogleSheetDisabledReason,
    googleAuthStatus.connected,
    labels.google.networkRetry,
    labels.google.syncTimeoutRetry,
    pendingSheetUpdateCount,
    getOrBuildGoogleSheetImportStaircaseIndex,
    scheduleGoogleSheetNetworkRetry,
    scheduleSheetSyncFlush,
    sheetSyncError,
  ]);

  const handleRetryGoogleSheetCheckboxDetection = useCallback(async () => {
    if (isRetryingGoogleSheetCheckboxDetection) {
      return;
    }

    const meta = googleSheetSyncMetaRef.current;
    if (!meta) {
      setSheetSyncStatus("failed");
      setSheetSyncError(labels.google.importFirst);
      return;
    }

    setIsRetryingGoogleSheetCheckboxDetection(true);
    setSheetSyncError(null);
    const manualColumnIndexBeforeRetry =
      meta.checkboxColumnSource === "manual"
        ? getSelectedGoogleSheetCheckboxColumnIndex(
            meta,
            manualCheckboxColumnInputRef.current,
          )
        : null;
    try {
      console.log("[googleSheetColumnsUI] retry checkbox detection", {
        spreadsheetId: meta.spreadsheetId,
        gid: meta.gid,
        rows: meta.rows.length,
        headersFirst5: meta.detectedHeaders?.slice(0, 5) ?? [],
      });

      const response = await fetch("/api/google-sheet/checkbox-detect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          spreadsheetId: meta.spreadsheetId,
          gid: meta.gid,
          sourceUrl: meta.sourceUrl,
          headers: meta.detectedHeaders ?? [],
          preferredColumnIndex: meta.checkboxColumnIndex ?? meta.doneColumnIndex,
          rowNumbers: meta.rows.map((row) => row.sourceRowNumber),
        }),
      });
      const result = (await response.json().catch(() => null)) as
        | GoogleSheetCheckboxColumnsResponse
        | null;

      if (!response.ok || !result?.success) {
        const rawError =
          result?.checkboxColumnDetectionError?.trim() ||
          result?.technicalDetail?.trim() ||
          result?.error?.trim() ||
          `Checkbox detection failed: HTTP ${response.status}`;
        const errorMessage =
          formatCheckboxDetectionError(rawError) || rawError;
        if (manualColumnIndexBeforeRetry !== null) {
          const manualColumnLetter = columnIndexToA1(
            manualColumnIndexBeforeRetry,
          );
          setManualCheckboxColumnInput(manualColumnLetter);
          manualCheckboxColumnInputRef.current = manualColumnLetter;
          setManualCheckboxColumnError(null);
          setGoogleSheetSyncMeta((current) =>
            current
              ? {
                  ...current,
                  checkboxColumnIndex: manualColumnIndexBeforeRetry,
                  doneColumnIndex: manualColumnIndexBeforeRetry,
                  checkboxColumnSource: "manual",
                  checkboxColumnDetectionError: null,
                }
              : current,
          );
          setSheetSyncStatus(
            pendingSheetUpdatesRef.current.size > 0 ? "pending" : "idle",
          );
          setSheetSyncError(
            `${errorMessage}; manual column kept: ${manualColumnLetter}`,
          );
          if (
            googleAuthConnectedRef.current &&
            pendingSheetUpdatesRef.current.size > 0
          ) {
            setAutoUpdateGoogleSheet(true);
            autoUpdateGoogleSheetRef.current = true;
            scheduleSheetSyncFlush(googleSheetSyncDefaultDelayMs, {
              replaceExisting: true,
            });
          }
          return;
        }
        setGoogleSheetSyncMeta((current) =>
          current
            ? {
                ...current,
                checkboxCandidates:
                  result?.checkboxCandidates &&
                  result.checkboxCandidates.length > 0
                    ? result.checkboxCandidates
                    : current.checkboxCandidates ?? [],
                checkboxColumnDetectionError: errorMessage,
              }
            : current,
        );
        throw new Error(errorMessage);
      }

      const errorMessage = formatCheckboxDetectionError(
        result.checkboxColumnDetectionError ?? result.error,
      );
      setGoogleSheetSyncMeta((current) => {
        if (
          !current ||
          current.spreadsheetId !== meta.spreadsheetId ||
          current.gid !== meta.gid
        ) {
          return current;
        }
        const currentManualColumnIndex =
          current.checkboxColumnSource === "manual"
            ? getSelectedGoogleSheetCheckboxColumnIndex(
                current,
                manualCheckboxColumnInputRef.current,
              )
            : null;
        if (currentManualColumnIndex !== null) {
          const currentCandidates = current.checkboxCandidates ?? [];
          const mergedCandidates = [
            ...currentCandidates,
            ...result.checkboxCandidates.filter(
              (candidate) =>
                !currentCandidates.some(
                  (currentCandidate) =>
                    currentCandidate.columnIndex === candidate.columnIndex,
                ),
            ),
          ];
          return {
            ...current,
            checkboxColumnIndex: currentManualColumnIndex,
            doneColumnIndex: currentManualColumnIndex,
            checkboxColumnSource: "manual",
            checkboxCandidates: mergedCandidates,
            checkboxColumnDetectionError: null,
          };
        }
        return {
          ...current,
          checkboxColumnIndex: fixedGoogleSheetCheckboxColumnIndex,
          doneColumnIndex: fixedGoogleSheetCheckboxColumnIndex,
          checkboxCandidates: result.checkboxCandidates,
          checkboxColumnSource: "fixed",
          checkboxColumnDetectionError: null,
        };
      });

      if (result.checkboxColumnIndex === null) {
        if (manualColumnIndexBeforeRetry !== null) {
          const manualColumnLetter = columnIndexToA1(
            manualColumnIndexBeforeRetry,
          );
          setManualCheckboxColumnInput(manualColumnLetter);
          manualCheckboxColumnInputRef.current = manualColumnLetter;
          setManualCheckboxColumnError(null);
          setSheetSyncStatus(
            pendingSheetUpdatesRef.current.size > 0 ? "pending" : "idle",
          );
          setSheetSyncError(
            `Checkbox detection did not find a column; manual column kept: ${manualColumnLetter}`,
          );
          if (
            googleAuthConnectedRef.current &&
            pendingSheetUpdatesRef.current.size > 0
          ) {
            setAutoUpdateGoogleSheet(true);
            autoUpdateGoogleSheetRef.current = true;
            scheduleSheetSyncFlush(googleSheetSyncDefaultDelayMs, {
              replaceExisting: true,
            });
          }
          return;
        }
        setManualCheckboxColumnInput(fixedGoogleSheetCheckboxColumnLetter);
        manualCheckboxColumnInputRef.current =
          fixedGoogleSheetCheckboxColumnLetter;
        setManualCheckboxColumnError(null);
        setSheetSyncStatus(
          pendingSheetUpdatesRef.current.size > 0 ? "pending" : "idle",
        );
        setSheetSyncError(null);
        return;
      }

      if (manualColumnIndexBeforeRetry !== null) {
        const manualColumnLetter = columnIndexToA1(
          manualColumnIndexBeforeRetry,
        );
        setManualCheckboxColumnInput(manualColumnLetter);
        manualCheckboxColumnInputRef.current = manualColumnLetter;
        setManualCheckboxColumnError(null);
        setSheetSyncStatus(
          pendingSheetUpdatesRef.current.size > 0 ? "pending" : "idle",
        );
        setSheetSyncError(
          `Checkbox detection completed; manual column kept: ${manualColumnLetter}`,
        );
        if (
          googleAuthConnectedRef.current &&
          pendingSheetUpdatesRef.current.size > 0
        ) {
          setAutoUpdateGoogleSheet(true);
          autoUpdateGoogleSheetRef.current = true;
          scheduleSheetSyncFlush(googleSheetSyncDefaultDelayMs, {
            replaceExisting: true,
          });
        }
        return;
      }

      setManualCheckboxColumnInput(fixedGoogleSheetCheckboxColumnLetter);
      manualCheckboxColumnInputRef.current =
        fixedGoogleSheetCheckboxColumnLetter;
      setManualCheckboxColumnError(null);
      setSheetSyncStatus("idle");
      setSheetSyncError(null);
      if (
        googleAuthConnectedRef.current &&
        pendingSheetUpdatesRef.current.size > 0
      ) {
        setAutoUpdateGoogleSheet(true);
        autoUpdateGoogleSheetRef.current = true;
        scheduleSheetSyncFlush(googleSheetSyncDefaultDelayMs, {
          replaceExisting: true,
        });
      }
    } catch (error) {
      setSheetSyncStatus("failed");
      setSheetSyncError(
        error instanceof Error ? error.message : labels.google.checkboxColumnNotFound,
      );
    } finally {
      setIsRetryingGoogleSheetCheckboxDetection(false);
    }
  }, [
    isRetryingGoogleSheetCheckboxDetection,
    labels.google,
    scheduleSheetSyncFlush,
  ]);

  const handleRebuildGoogleRowIndex = useCallback(async () => {
    const meta = googleSheetSyncMetaRef.current;
    console.log(
      `[googleSheetWritebackIndex] rebuild requested source=${getGoogleSheetWritebackIndexSource(meta)}`,
    );
    setIsRebuildingGoogleRowIndex(true);
    setGoogleRowIndexStatus("building");
    googleRowIndexStatusRef.current = "building";
    const rowIndex = buildGoogleSheetRowIndexFromSourceMetadata(meta);
    setIsRebuildingGoogleRowIndex(false);
    if (!rowIndex) {
      const message = labels.google.rowIndexFailed;
      setGoogleRowIndexStatus("failed");
      googleRowIndexStatusRef.current = "failed";
      setGoogleRowIndexLastError(message);
      googleRowIndexLastErrorRef.current = message;
      setGoogleSheetRowIndexError(message);
      setSheetSyncStatus("failed");
      setSheetSyncError(message);
      return;
    }
    setGoogleSheetRowIndex(rowIndex);
    googleSheetRowIndexRef.current = rowIndex;
    setGoogleRowIndexStatus("ready");
    googleRowIndexStatusRef.current = "ready";
    setGoogleRowIndexLastError(null);
    googleRowIndexLastErrorRef.current = null;
    setGoogleSheetRowIndexError(null);
    const requeuedSkippedCount =
      requeueResolvedSkippedGoogleSheetWritebacks(rowIndex);
    console.log(
      `[googleSheetWritebackIndex] rebuild success mappedEvents=${rowIndex.indexedEventCount}`,
    );
    console.log(
      `[googleSheetWritebackIndex] requeuedSkipped=${requeuedSkippedCount}`,
    );
    setSheetSyncStatus(
      pendingSheetUpdatesRef.current.size > 0 ? "pending" : "idle",
    );
    setSheetSyncError(
      `Google writeback index rebuilt: ${rowIndex.indexedEventCount} events, ${rowIndex.rowCount} rows.`,
    );
    if (
      autoUpdateGoogleSheetRef.current &&
      googleAuthConnectedRef.current &&
      pendingSheetUpdatesRef.current.size > 0
    ) {
      scheduleNextGoogleSheetFlushBecausePendingRef.current?.(0, {
        replaceExisting: true,
      });
    }
  }, [labels.google.rowIndexFailed, requeueResolvedSkippedGoogleSheetWritebacks]);

  const handleManualGoogleSheetCheckboxColumnChange = useCallback(
    (value: string) => {
      manualCheckboxColumnInputRef.current = value;
      setManualCheckboxColumnInput(value);
      setManualCheckboxColumnError(
        value.trim() && a1ColumnToIndex(value) === null
          ? labels.google.invalidColumnLetter
          : null,
      );
      const columnIndex = a1ColumnToIndex(value);
      const meta = googleSheetSyncMetaRef.current;
      if (columnIndex === null || !meta || googleSheetSourceUrl === null) {
        return;
      }
      const columnLetter = columnIndexToA1(columnIndex);
      rememberManualGoogleSheetSyncSettings({
        manualCheckboxColumnInput: columnLetter,
        checkboxColumnSource: "manual",
      });
      const manualCandidate: GoogleSheetCheckboxCandidate = {
        columnIndex,
        count: 0,
        dataValidationCount: 0,
        boolValueCount: 0,
        header: "Manual",
      };
      setManualCheckboxColumnInput(columnLetter);
      manualCheckboxColumnInputRef.current = columnLetter;
      setGoogleSheetSyncMeta((current) => {
        if (
          !current ||
          current.spreadsheetId !== meta.spreadsheetId ||
          current.gid !== meta.gid
        ) {
          return current;
        }
        const otherCandidates = (current.checkboxCandidates ?? []).filter(
          (candidate) =>
            candidate.columnIndex !== columnIndex &&
            candidate.header !== "Manual",
        );
        const nextMeta: GoogleSheetSyncMetadata = {
          ...current,
          checkboxColumnIndex: columnIndex,
          doneColumnIndex: columnIndex,
          checkboxColumnSource: "manual",
          checkboxColumnDetectionError: null,
          checkboxCandidates: [manualCandidate, ...otherCandidates],
        };
        googleSheetSyncMetaRef.current = nextMeta;
        return nextMeta;
      });
    },
    [googleSheetSourceUrl, labels.google, rememberManualGoogleSheetSyncSettings],
  );

  const handleManualGoogleSheetTitleChange = useCallback((value: string) => {
    setManualSheetTitleInput(value);
  }, []);

  const handleSaveManualGoogleSheetTitle = useCallback(() => {
    const meta = googleSheetSyncMetaRef.current;
    if (!meta || googleSheetSourceUrl === null) {
      setSheetSyncStatus("failed");
      setSheetSyncError(labels.google.importFirst);
      return;
    }

    const manualSheetTitle = manualSheetTitleInput.trim();
    if (!manualSheetTitle) {
      setSheetSyncStatus("failed");
      setSheetSyncError(labels.google.sheetTabNameRequired);
      return;
    }

    setManualSheetTitleInput(manualSheetTitle);
    rememberManualGoogleSheetSyncSettings({
      manualSheetTitle,
      sheetTitleSource: "manual",
    });
    const retitledRowIndex = retitleGoogleSheetRowIndex(
      googleSheetRowIndexRef.current,
      manualSheetTitle,
    );
    setGoogleSheetRowIndex(retitledRowIndex);
    googleSheetRowIndexRef.current = retitledRowIndex;
    setGoogleRowIndexStatus(retitledRowIndex ? "ready" : "idle");
    googleRowIndexStatusRef.current = retitledRowIndex ? "ready" : "idle";
    setGoogleRowIndexLastError(null);
    googleRowIndexLastErrorRef.current = null;
    setGoogleSheetRowIndexError(null);
    const nextMeta = withGoogleSheetTitle(meta, manualSheetTitle, "manual");
    googleSheetSyncMetaRef.current = nextMeta;
    setGoogleSheetSyncMeta((current) => {
      if (
        !current ||
        current.spreadsheetId !== meta.spreadsheetId ||
        current.gid !== meta.gid
      ) {
        return current;
      }
      return nextMeta;
    });
    setSheetSyncStatus(
      pendingSheetUpdatesRef.current.size > 0 ? "pending" : "idle",
    );
    setSheetSyncError(labels.google.sheetTabSaved(manualSheetTitle));
    if (googleAuthConnectedRef.current) {
      if (pendingSheetUpdatesRef.current.size > 0) {
        setAutoUpdateGoogleSheet(true);
        autoUpdateGoogleSheetRef.current = true;
        setSheetSyncStatus("pending");
      }
      const nextIndex =
        retitledRowIndex ?? getOrBuildGoogleSheetImportStaircaseIndex(nextMeta);
      if (nextIndex) {
        scheduleNextGoogleSheetFlushBecausePendingRef.current?.(
          googleSheetSyncDebounceMs,
          { replaceExisting: true },
        );
      }
    }
  }, [
    getOrBuildGoogleSheetImportStaircaseIndex,
    googleSheetSourceUrl,
    labels.google,
    manualSheetTitleInput,
    rememberManualGoogleSheetSyncSettings,
  ]);

  const handleUseManualGoogleSheetCheckboxColumn = useCallback(() => {
    const meta = googleSheetSyncMetaRef.current;
    if (!meta || googleSheetSourceUrl === null) {
      setSheetSyncStatus("failed");
      setSheetSyncError(labels.google.importFirst);
      return;
    }

    const columnIndex = a1ColumnToIndex(manualCheckboxColumnInput);
    if (columnIndex === null) {
      setManualCheckboxColumnError(labels.google.invalidColumnLetter);
      setSheetSyncStatus("failed");
      setSheetSyncError(labels.google.invalidColumnLetter);
      return;
    }

    const columnLetter = columnIndexToA1(columnIndex);
    rememberManualGoogleSheetSyncSettings({
      manualCheckboxColumnInput: columnLetter,
      checkboxColumnSource: "manual",
    });
    const manualCandidate: GoogleSheetCheckboxCandidate = {
      columnIndex,
      count: 0,
      dataValidationCount: 0,
      boolValueCount: 0,
      header: "Manual",
    };

    setManualCheckboxColumnInput(columnLetter);
    manualCheckboxColumnInputRef.current = columnLetter;
    setManualCheckboxColumnError(null);
    setGoogleSheetSyncMeta((current) => {
      if (
        !current ||
        current.spreadsheetId !== meta.spreadsheetId ||
        current.gid !== meta.gid
      ) {
        return current;
      }
      const otherCandidates = (current.checkboxCandidates ?? []).filter(
        (candidate) =>
          candidate.columnIndex !== columnIndex &&
          candidate.header !== "Manual",
      );
      const nextMeta: GoogleSheetSyncMetadata = {
        ...current,
        checkboxColumnIndex: columnIndex,
        doneColumnIndex: columnIndex,
        checkboxColumnSource: "manual",
        checkboxColumnDetectionError: null,
        checkboxCandidates: [manualCandidate, ...otherCandidates],
      };
      googleSheetSyncMetaRef.current = nextMeta;
      return nextMeta;
    });

    setSheetSyncStatus(
      pendingSheetUpdatesRef.current.size > 0 ? "pending" : "idle",
    );
    setSheetSyncError(null);
    if (
      googleAuthConnectedRef.current &&
      pendingSheetUpdatesRef.current.size > 0
    ) {
      setAutoUpdateGoogleSheet(true);
      autoUpdateGoogleSheetRef.current = true;
      scheduleSheetSyncFlush(googleSheetSyncDefaultDelayMs, {
        replaceExisting: true,
      });
    }
  }, [
    googleSheetSourceUrl,
    labels.google,
    manualCheckboxColumnInput,
    rememberManualGoogleSheetSyncSettings,
    scheduleSheetSyncFlush,
  ]);

  const runGoogleSheetDebugWrite = useCallback(async (options: {
    debugLabel:
      | "testWrite"
      | "exactG69"
      | "exactG69A1"
      | "exactG85"
      | "exactG85A1";
    hasPassedRows: boolean;
    rowId: string;
    rowNumber: number;
    eventName: string;
    checkboxColumnIndex: number;
  }) => {
    const meta = googleSheetSyncMetaRef.current;
    if (!meta) {
      setSheetSyncStatus("failed");
      setSheetSyncError(labels.google.importFirst);
      setLastGoogleSheetSyncStatus("failed");
      setLastGoogleSheetSyncUpdatedRows([]);
      return;
    }

    const checkboxColumnLetter = columnIndexToA1(options.checkboxColumnIndex);
    const writeSheetTitle = getGoogleSheetWriteSheetTitle(meta);
    if (writeSheetTitle === null) {
      setSheetSyncStatus("failed");
      setSheetSyncError(labels.google.sheetTabNameRequired);
      setLastGoogleSheetSyncStatus("failed");
      setLastGoogleSheetSyncUpdatedRows([]);
      return;
    }
    const sheetId = Number(meta.gid);
    const gridRange = {
      sheetId,
      startRowIndex: options.rowNumber - 1,
      endRowIndex: options.rowNumber,
      startColumnIndex: options.checkboxColumnIndex,
      endColumnIndex: options.checkboxColumnIndex + 1,
    };
    const range = buildGoogleSheetA1Range(
      writeSheetTitle,
      options.checkboxColumnIndex,
      options.rowNumber,
    );
    setLastGoogleSheetTargetRange(range);
    const googleApiEndpoint = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      meta.spreadsheetId,
    )}/values:batchUpdate`;
    const googleApiRequestBody = {
      valueInputOption: "USER_ENTERED",
      data: [
        {
          range,
          values: [[true]],
        },
      ],
    };

    console.log("[googleSheetTestWrite] clicked");
    console.log(`[googleSheetTestWrite] hasPassedRows=${options.hasPassedRows}`);
    console.log(`[googleSheetTestWrite] selectedRowId=${options.rowId}`);
    console.log(`[googleSheetTestWrite] eventName=${options.eventName}`);
    console.log(`[googleSheetTestWrite] sourceRowNumber=${options.rowNumber}`);
    console.log(`[googleSheetTestWrite] spreadsheetId=${meta.spreadsheetId}`);
    console.log(`[googleSheetTestWrite] gid=${meta.gid}`);
    console.log(
      `[googleSheetTestWrite] checkboxColumnIndex=${options.checkboxColumnIndex}`,
    );
    console.log(
      `[googleSheetTestWrite] checkboxColumnLetter=${checkboxColumnLetter}`,
    );
    console.log("[googleSheetTestWrite] writeMode=A1 batchUpdate");
    console.log(`[googleSheetTestWrite] sheetTitle=${meta.sheetTitle ?? "null"}`);
    console.log(
      `[googleSheetTestWrite] manualSheetTitle=${
        meta.manualSheetTitle ?? "null"
      }`,
    );
    console.log(`[googleSheetTestWrite] range=${range}`);

    setLastGoogleSheetTestWriteDebugInfo(
      formatGoogleSheetTestWriteDebug({
        writeMode: "A1 batchUpdate",
        hasPassedRows: options.hasPassedRows,
        selectedRowId: options.rowId,
        eventName: options.eventName,
        rowNumber: options.rowNumber,
        firstMappedRowNumber: meta.rows[0]?.sourceRowNumber ?? null,
        spreadsheetId: meta.spreadsheetId,
        gid: meta.gid,
        sheetTitle: meta.sheetTitle,
        manualSheetTitle: meta.manualSheetTitle ?? null,
        checkboxColumnIndex: options.checkboxColumnIndex,
        columnLetter: checkboxColumnLetter,
        gridRange,
        range,
        endpoint: googleApiEndpoint,
        requestBody: googleApiRequestBody,
      }),
    );
    setSheetSyncStatus("syncing");
    setSheetSyncError(null);
    try {
      const response = await fetch("/api/google-sheet/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          debugLabel: options.debugLabel,
          spreadsheetId: meta.spreadsheetId,
          gid: meta.gid,
          sheetTitle: meta.sheetTitle,
          manualSheetTitle: meta.manualSheetTitle,
          updates: [
            {
              rowId: options.rowId,
              rowNumber: options.rowNumber,
              eventName: options.eventName,
              checkboxColumnIndex: options.checkboxColumnIndex,
              statusColumnIndex: null,
              doneColumnIndex: options.checkboxColumnIndex,
              checkColumnIndex: null,
            },
          ],
        }),
      });
      const result = (await response.json().catch(() => null)) as
        | GoogleSheetSyncResponse
        | null;

      if (!response.ok || !result?.success) {
        rememberGoogleSheetSyncDebug(result);
        const error =
          result?.error ?? `${labels.google.sheetSyncFailed}: HTTP ${response.status}`;
        const detail = result?.technicalDetail?.trim();
        const message = detail ? `${error}: ${detail}` : error;
        setLastGoogleSheetTestWriteDebugInfo(
          formatGoogleSheetTestWriteDebug({
            writeMode: result?.writeMode ?? "A1 batchUpdate",
            hasPassedRows: options.hasPassedRows,
            selectedRowId: options.rowId,
            eventName: options.eventName,
            rowNumber: options.rowNumber,
            firstMappedRowNumber: meta.rows[0]?.sourceRowNumber ?? null,
            spreadsheetId: meta.spreadsheetId,
            gid: meta.gid,
            sheetTitle: meta.sheetTitle,
            manualSheetTitle: meta.manualSheetTitle ?? null,
            checkboxColumnIndex: options.checkboxColumnIndex,
            columnLetter: checkboxColumnLetter,
            gridRange,
            range:
              Array.isArray(result?.ranges) &&
              typeof result.ranges[0] === "string"
                ? result.ranges[0]
                : range,
            endpoint: result?.endpoint ?? googleApiEndpoint,
            requestBody: result?.requestBody ?? googleApiRequestBody,
            apiStatus: result?.apiStatus ?? null,
            apiResponse: result?.apiResponse ?? message,
            technicalDetail: result?.technicalDetail ?? null,
            errorName: result?.errorName ?? null,
            errorMessage: result?.errorMessage ?? null,
            causeCode: result?.causeCode ?? null,
            causeMessage: result?.causeMessage ?? null,
            attemptCount: result?.attemptCount ?? null,
            attempts: result?.attempts,
            totalUpdatedCells: result?.totalUpdatedCells ?? null,
            totalUpdatedRows: result?.totalUpdatedRows ?? null,
            warning: result?.networkIssue
              ? "Network exception before Google HTTP response."
              : null,
          }),
        );
        throw new Error(message);
      }

      const warning =
        result.warning ??
        (result.apiStatus === 200
          ? "Google API accepted update but visible sheet did not change. Check target row/column."
          : null);
      const updatedRows = Array.isArray(result.updatedRowIds)
        ? result.updatedRowIds.filter(
            (value): value is string => typeof value === "string",
          )
        : [options.rowId];
      setLastGoogleSheetSyncStatus("success");
      setLastGoogleSheetSyncUpdatedRows(updatedRows);
      rememberGoogleSheetSyncDebug(result);
      setLastGoogleSheetTestWriteDebugInfo(
        formatGoogleSheetTestWriteDebug({
          writeMode: result.writeMode ?? "A1 batchUpdate",
          hasPassedRows: options.hasPassedRows,
          selectedRowId: options.rowId,
          eventName: options.eventName,
          rowNumber: options.rowNumber,
          firstMappedRowNumber: meta.rows[0]?.sourceRowNumber ?? null,
          spreadsheetId: meta.spreadsheetId,
          gid: meta.gid,
          sheetTitle: meta.sheetTitle,
          manualSheetTitle: meta.manualSheetTitle ?? null,
          checkboxColumnIndex: options.checkboxColumnIndex,
          columnLetter: checkboxColumnLetter,
          gridRange,
          range:
            Array.isArray(result.ranges) && typeof result.ranges[0] === "string"
              ? result.ranges[0]
              : range,
          endpoint: result.endpoint ?? googleApiEndpoint,
          requestBody: result.requestBody ?? googleApiRequestBody,
          apiStatus: result.apiStatus,
          apiResponse: result.apiResponse,
          totalUpdatedCells: result.totalUpdatedCells,
          totalUpdatedRows: result.totalUpdatedRows,
          warning,
        }),
      );
      setSheetSyncStatus("synced");
      setSheetSyncError(
        warning ??
          `Test write row=${options.rowNumber} column=${checkboxColumnLetter}`,
      );
    } catch (error) {
      setLastGoogleSheetSyncStatus("failed");
      setLastGoogleSheetSyncUpdatedRows([]);
      setSheetSyncStatus("failed");
      setSheetSyncError(error instanceof Error ? error.message : labels.google.sheetSyncFailed);
      setLastGoogleSheetTestWriteDebugInfo((current) =>
        current
          ? `${current}\napiStatus=failed\napiResponse=${compactDebugValue(
              error instanceof Error ? error.message : String(error),
            )}`
          : null,
      );
    }
  }, [labels.google, rememberGoogleSheetSyncDebug]);

  const handleTestGoogleSheetWrite = useCallback(async () => {
    const meta = googleSheetSyncMetaRef.current;
    const checkboxColumnIndex = getSelectedGoogleSheetCheckboxColumnIndex(
      meta,
      manualCheckboxColumnInputRef.current,
    );
    if (!meta || checkboxColumnIndex === null) {
      setSheetSyncStatus("failed");
      setSheetSyncError(labels.google.checkboxColumnNotFound);
      setLastGoogleSheetSyncStatus("failed");
      setLastGoogleSheetSyncUpdatedRows([]);
      return;
    }

    const passedLog = matchBundle?.logs.find(
      (log) => log.matchType === "passed" && log.matchedRowId,
    );
    const rowId = passedLog?.matchedRowId ?? null;
    const sourceRow = rowId ? meta.rows.find((row) => row.rowId === rowId) : null;
    const eventName = passedLog ? getPassedLogGoogleSheetEventName(passedLog) : "";
    console.log("[googleSheetTestWrite] clicked");
    console.log(
      `[googleSheetTestWrite] hasPassedRows=${Boolean(rowId)}`,
    );
    console.log(`[googleSheetTestWrite] selectedRowId=${rowId ?? "null"}`);
    console.log(`[googleSheetTestWrite] eventName=${eventName}`);
    console.log(
      `[googleSheetTestWrite] sourceRowNumber=${
        sourceRow?.sourceRowNumber ?? "null"
      }`,
    );
    console.log(`[googleSheetTestWrite] spreadsheetId=${meta.spreadsheetId}`);
    console.log(`[googleSheetTestWrite] gid=${meta.gid}`);
    console.log(
      `[googleSheetTestWrite] checkboxColumnIndex=${checkboxColumnIndex}`,
    );
    console.log(
      `[googleSheetTestWrite] checkboxColumnLetter=${columnIndexToA1(
        checkboxColumnIndex,
      )}`,
    );
    if (!rowId) {
      setSheetSyncStatus("failed");
      setSheetSyncError("No passed rows yet. Trigger one event first.");
      setLastGoogleSheetSyncStatus("failed");
      setLastGoogleSheetSyncUpdatedRows([]);
      setLastGoogleSheetTestWriteDebugInfo(
        "hasPassedRows=false\nwarning=No passed rows yet. Trigger one event first.",
      );
      return;
    }

    const rowIndex = await ensureGoogleSheetRowIndex();
    const rowIndexTarget = getGoogleSheetRowIndexWriteTarget(
      rowIndex,
      eventName,
    );
    if (rowIndexTarget.reason !== null || rowIndexTarget.rowNumber === null) {
      const writeSheetTitle = getGoogleSheetWriteSheetTitle(meta);
      setSheetSyncStatus("failed");
      setSheetSyncError(rowIndexTarget.reason ?? "Google row index failed");
      setLastGoogleSheetSyncStatus("failed");
      setLastGoogleSheetSyncUpdatedRows([]);
      setLastGoogleSheetTestWriteDebugInfo(
        [
          "writeMode=A1 batchUpdate",
          "hasPassedRows=true",
          `selectedRowId=${rowId}`,
          `eventName=${eventName}`,
          `sourceRowNumber=${sourceRow?.sourceRowNumber ?? "null"}`,
          `foundRowNumber=${rowIndexTarget.rowNumber ?? "null"}`,
          `firstMappedRowNumber=${meta.rows[0]?.sourceRowNumber ?? "null"}`,
          `spreadsheetId=${meta.spreadsheetId}`,
          `gid=${meta.gid}`,
          `sheetTitle=${writeSheetTitle ?? "null"}`,
          `manualSheetTitle=${meta.manualSheetTitle ?? "null"}`,
          `checkboxColumnIndex=${checkboxColumnIndex}`,
          `checkboxColumnLetter=${columnIndexToA1(checkboxColumnIndex)}`,
          "range=null",
          `leaf=${rowIndexTarget.debugRow?.leaf ?? false}`,
          `parent=${rowIndexTarget.debugRow?.parent ?? false}`,
          `gValue=${rowIndexTarget.debugRow?.gValue || "null"}`,
          `gIsBooleanLike=${rowIndexTarget.debugRow?.gIsBooleanLike ?? false}`,
          `candidates=${rowIndexTarget.candidates || "none"}`,
          `warning=${rowIndexTarget.reason ?? "Google row index failed"}`,
        ].join("\n"),
      );
      return;
    }

    await runGoogleSheetDebugWrite({
      debugLabel: "testWrite",
      hasPassedRows: true,
      rowId,
      rowNumber: rowIndexTarget.rowNumber,
      eventName,
      checkboxColumnIndex,
    });
  }, [
    ensureGoogleSheetRowIndex,
    labels.google,
    matchBundle,
    runGoogleSheetDebugWrite,
  ]);

  const handleTestGoogleSheetExactG69 = useCallback(async () => {
    const meta = googleSheetSyncMetaRef.current;
    if (!meta || googleSheetSourceUrl === null) {
      setSheetSyncStatus("failed");
      setSheetSyncError(labels.google.importFirst);
      return;
    }

    await runGoogleSheetDebugWrite({
      debugLabel: "exactG69A1",
      hasPassedRows: true,
      rowId: "debug-exact-g69",
      rowNumber: 69,
      eventName: "debug exact G69 A1",
      checkboxColumnIndex: 6,
    });
  }, [googleSheetSourceUrl, labels.google, runGoogleSheetDebugWrite]);

  const handleTestGoogleSheetExactG85 = useCallback(async () => {
    const meta = googleSheetSyncMetaRef.current;
    if (!meta || googleSheetSourceUrl === null) {
      setSheetSyncStatus("failed");
      setSheetSyncError(labels.google.importFirst);
      return;
    }

    await runGoogleSheetDebugWrite({
      debugLabel: "exactG85A1",
      hasPassedRows: true,
      rowId: "debug-exact-g85",
      rowNumber: 85,
      eventName: "debug exact G85 A1",
      checkboxColumnIndex: fixedGoogleSheetCheckboxColumnIndex,
    });
  }, [googleSheetSourceUrl, labels.google, runGoogleSheetDebugWrite]);

  const updateSettingsPopoverPosition = useCallback(() => {
    const button = settingsButtonRef.current;
    if (!button) {
      return;
    }

    const rect = button.getBoundingClientRect();
    const popoverHeight =
      settingsPopoverRef.current?.offsetHeight || settingsPopoverHeightPx;
    const maxLeft = Math.max(
      settingsPopoverViewportPaddingPx,
      window.innerWidth -
        settingsPopoverWidthPx -
        settingsPopoverViewportPaddingPx,
    );
    const left = Math.min(
      Math.max(
        rect.right + settingsPopoverOffsetPx,
        settingsPopoverViewportPaddingPx,
      ),
      maxLeft,
    );
    const maxTop = Math.max(
      settingsPopoverViewportPaddingPx,
      window.innerHeight - popoverHeight - settingsPopoverViewportPaddingPx,
    );
    const top = Math.min(
      Math.max(rect.top, settingsPopoverViewportPaddingPx),
      maxTop,
    );

    setSettingsPopoverPosition({ left, top });
  }, []);

  const handleSettingsButtonClick = useCallback(() => {
    updateSettingsPopoverPosition();
    setSettingsOpen((open) => !open);
  }, [updateSettingsPopoverPosition]);

  useEffect(() => {
    if (!settingsOpen) {
      return;
    }

    updateSettingsPopoverPosition();
    window.addEventListener("resize", updateSettingsPopoverPosition);
    window.addEventListener("scroll", updateSettingsPopoverPosition, true);
    return () => {
      window.removeEventListener("resize", updateSettingsPopoverPosition);
      window.removeEventListener("scroll", updateSettingsPopoverPosition, true);
    };
  }, [settingsOpen, updateSettingsPopoverPosition]);

  useEffect(() => {
    if (!settingsOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        target &&
        (settingsPopoverRef.current?.contains(target) ||
          settingsButtonRef.current?.contains(target))
      ) {
        return;
      }

      setSettingsOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSettingsOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [settingsOpen]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(androidPackageNamesStorageKey);
      if (!raw) {
        return;
      }

      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return;
      }

      const packageNames = Array.from(
        new Set(
          parsed
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim())
            .filter(Boolean),
        ),
      );

      if (packageNames.length === 0) {
        setSavedAndroidPackageNames([]);
        return;
      }

      setSavedAndroidPackageNames(packageNames);
    } catch (e) {
      console.warn("[android-package] failed to load saved package names", e);
    }
  }, []);

  const resolveLiveFeedScrollElement = useCallback(() => {
    if (liveFeedScrollRef.current) {
      return liveFeedScrollRef.current;
    }
    const labels = Array.from(document.querySelectorAll("p"));
    const liveLabel = labels.find((el) => {
      const text = el.textContent?.trim().toLowerCase() ?? "";
      return (
        text.includes("live log (last 100)") ||
        text.includes("live-лог (последние 100)")
      );
    });
    const container = liveLabel?.nextElementSibling as HTMLElement | null;
    if (container) {
      liveFeedScrollRef.current = container;
    }
    return container;
  }, []);

  const handleLiveFeedLineClick = useCallback((clickedId: string, clickedText: string) => {
    console.debug("[live-click-debug] clickedId:", clickedId);
    console.debug("[live-click-debug] clickedText:", clickedText);
    if (activePlatform === "unity") {
      setSelectedUnityLiveFeedLineId(clickedId);
    } else {
      setSelectedLiveFeedLineId(clickedId);
    }
    if (!matchBundle?.logs.length) {
      console.debug("[live-click-debug] no logs in current matchBundle");
      return;
    }

    const base = clickedText.trim();
    if (!base) {
      console.debug("[live-click-debug] clicked text is empty after trim");
      return;
    }

    const extracted = extractAnalyticsPayload(base);
    console.debug("[live-click-debug] extracted from clicked text:", extracted);
    const cleanedExtracted = extracted ? finalizeLivePayload(extracted) : null;
    console.debug(
      "[live-click-debug] extracted after finalizeLivePayload:",
      cleanedExtracted,
    );
    const targetPayload = normalizeValue(cleanedExtracted ?? finalizeLivePayload(base));
    console.debug("[live-click-debug] target normalized payload:", targetPayload);
    if (!targetPayload) {
      console.debug("[live-click-debug] target payload is empty after normalize");
      return;
    }

    const logs = matchBundle.logs;
    let matched = false;
    for (let i = logs.length - 1; i >= 0; i -= 1) {
      const log = logs[i];
      const logPayload = normalizeValue(finalizeLivePayload(log.extracted ?? ""));
      if (logPayload !== targetPayload) {
        continue;
      }
      matched = true;
      console.debug("[live-click-debug] matched log found:", {
        logId: log.id,
        extracted: log.extracted,
        normalizedExtracted: logPayload,
        matchedRowId: log.matchedRowId,
      });
      if (log.matchedRowId) {
        console.debug("[live-click-debug] matchedRowId:", log.matchedRowId);
        console.debug(
          "[live-click-debug] setSelectedRowId called with:",
          log.matchedRowId,
        );
        setSelectedRowId(log.matchedRowId);
      } else {
        console.debug(
          "[live-click-debug] matched log has null matchedRowId (setSelectedRowId not called)",
        );
      }
      return;
    }
    if (!matched) {
      console.debug("[live-click-debug] no matched log found");
      const recent = logs.slice(-5).map((log) => ({
        extracted: log.extracted,
        normalizedExtracted: normalizeValue(
          finalizeLivePayload(log.extracted ?? ""),
        ),
        matchedRowId: log.matchedRowId,
      }));
      console.debug("[live-click-debug] recent logs sample:", recent);
    }
  }, [activePlatform, matchBundle]);

  useEffect(() => {
    if (matchBundle === null) {
      knownMatchResultIdsRef.current = new Set();
      for (const timeout of highlightTimeoutsRef.current.values()) {
        window.clearTimeout(timeout);
      }
      highlightTimeoutsRef.current.clear();
      setHighlightedMatchResultIds((prev) => (prev.length ? [] : prev));
      return;
    }

    const logs = matchBundle.logs;
    const knownIds = knownMatchResultIdsRef.current;
    const newVisibleIds = logs
      .filter((log) => !knownIds.has(log.id))
      .filter((log) => doesLogMatchSidebarFilter(log, activeSidebarFilter))
      .map((log) => log.id);

    knownMatchResultIdsRef.current = new Set(logs.map((log) => log.id));

    if (newVisibleIds.length === 0) {
      return;
    }

    setHighlightedMatchResultIds((prev) => {
      const next = [...prev];
      for (const id of newVisibleIds) {
        if (!next.includes(id)) {
          next.push(id);
        }
      }
      return next;
    });
    setRecentResultsScrollSignal((value) => value + 1);

    for (const id of newVisibleIds) {
      const existingTimeout = highlightTimeoutsRef.current.get(id);
      if (existingTimeout !== undefined) {
        window.clearTimeout(existingTimeout);
      }
      const timeout = window.setTimeout(() => {
        setHighlightedMatchResultIds((prev) =>
          prev.filter((highlightedId) => highlightedId !== id),
        );
        highlightTimeoutsRef.current.delete(id);
      }, 2200);
      highlightTimeoutsRef.current.set(id, timeout);
    }
  }, [activeSidebarFilter, matchBundle]);

  useEffect(() => {
    if (matchBundle === null) {
      setUnknownLiveResults((current) => (current.length ? [] : current));
      unknownLiveResultsRef.current = [];
      unknownLiveLogIdsRef.current = new Set();
      return;
    }

    const additions: UnknownLiveResult[] = [];
    for (const log of matchBundle.logs) {
      if (unknownLiveLogIdsRef.current.has(log.id)) {
        continue;
      }
      const unknownResult = buildUnknownLiveResult(log);
      if (!unknownResult) {
        continue;
      }
      unknownLiveLogIdsRef.current.add(log.id);
      additions.push(unknownResult);
      console.log(
        `[unknownResult] added event=${unknownResult.eventName} normalized=${unknownResult.normalizedEventName} reason=${unknownResult.reason}`,
      );
    }

    if (additions.length === 0) {
      return;
    }

    setUnknownLiveResults((current) => {
      const knownIds = new Set(current.map((result) => result.id));
      const next = [
        ...current,
        ...additions.filter((result) => !knownIds.has(result.id)),
      ].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
      unknownLiveResultsRef.current = next;
      return next;
    });
  }, [matchBundle]);

  useEffect(() => {
    return () => {
      for (const timeout of highlightTimeoutsRef.current.values()) {
        window.clearTimeout(timeout);
      }
      highlightTimeoutsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (recentResultsScrollSignal === 0) {
      return;
    }
    recentResultsRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [recentResultsScrollSignal]);

  useEffect(() => {
    if (matchBundle === null) {
      knownTableLogIdsRef.current = new Set();
      for (const timeout of tableHighlightTimeoutsRef.current.values()) {
        window.clearTimeout(timeout);
      }
      tableHighlightTimeoutsRef.current.clear();
      setHighlightedTableRowIds((prev) => (prev.length ? [] : prev));
      return;
    }

    const knownIds = knownTableLogIdsRef.current;
    const newVisibleRowIds = Array.from(
      new Set(
        matchBundle.logs
          .filter((log) => !knownIds.has(log.id))
          .map((log) => {
            if (doesLogUpdateVisibleTableRow(log, activeSidebarFilter)) {
              return log.matchedRowId as string;
            }
            if (
              (activeSidebarFilter === "all" ||
                activeSidebarFilter === "unknown") &&
              log.matchType === "unknown" &&
              log.matchedRowId === null
            ) {
              return buildUnknownLiveResult(log)?.id ?? null;
            }
            return null;
          })
          .filter((rowId): rowId is string => rowId !== null),
      ),
    );

    knownTableLogIdsRef.current = new Set(
      matchBundle.logs.map((log) => log.id),
    );

    if (newVisibleRowIds.length === 0) {
      return;
    }

    setHighlightedTableRowIds((prev) => {
      const next = [...prev];
      for (const rowId of newVisibleRowIds) {
        if (!next.includes(rowId)) {
          next.push(rowId);
        }
      }
      return next;
    });
    setTableScrollSignal((value) => value + 1);

    for (const rowId of newVisibleRowIds) {
      const existingTimeout = tableHighlightTimeoutsRef.current.get(rowId);
      if (existingTimeout !== undefined) {
        window.clearTimeout(existingTimeout);
      }
      const timeout = window.setTimeout(() => {
        setHighlightedTableRowIds((prev) =>
          prev.filter((highlightedRowId) => highlightedRowId !== rowId),
        );
        tableHighlightTimeoutsRef.current.delete(rowId);
      }, 2600);
      tableHighlightTimeoutsRef.current.set(rowId, timeout);
    }
  }, [activeSidebarFilter, matchBundle]);

  useEffect(() => {
    return () => {
      for (const timeout of tableHighlightTimeoutsRef.current.values()) {
        window.clearTimeout(timeout);
      }
      tableHighlightTimeoutsRef.current.clear();
    };
  }, []);

  const specRowSource: AnalyticsSpecRow[] | null = useMemo(() => {
    if (importResult === null) return null;
    return matchBundle?.rows ?? importResult.rows;
  }, [importResult, matchBundle]);

  const rowUpdateTimes = useMemo(() => {
    const all = new Map<string, number>();
    const passed = new Map<string, number>();
    const duplicate = new Map<string, number>();
    const unknown = new Map<string, number>();

    for (const log of matchBundle?.logs ?? []) {
      if (!log.matchedRowId) {
        continue;
      }
      setLatestRowUpdate(all, log.matchedRowId, log.timestamp);
      if (log.matchType === "passed") {
        setLatestRowUpdate(passed, log.matchedRowId, log.timestamp);
      }
      if (log.matchType === "duplicate") {
        setLatestRowUpdate(duplicate, log.matchedRowId, log.timestamp);
      }
      if (log.matchType === "unknown") {
        setLatestRowUpdate(unknown, log.matchedRowId, log.timestamp);
      }
    }

    return { all, passed, duplicate, unknown };
  }, [matchBundle]);

  const filteredTableRowSource: AnalyticsSpecRow[] | null = useMemo(() => {
    if (specRowSource === null) return null;

    if (activeSidebarFilter === "all") {
      const highlightedRowIdSet = new Set(highlightedTableRowIds);
      const promoted = orderRowsByLatestUpdate(
        specRowSource.filter((r) => highlightedRowIdSet.has(r.id)),
        rowUpdateTimes.all,
      );
      const stable = specRowSource.filter((r) => !highlightedRowIdSet.has(r.id));
      return [...promoted, ...stable];
    }

    if (activeSidebarFilter === "passed") {
      return orderRowsByLatestUpdate(
        specRowSource.filter((r) => r.status === "matched"),
        rowUpdateTimes.passed,
      );
    }

    if (activeSidebarFilter === "not_checked") {
      return specRowSource.filter((r) => r.status === "not_checked");
    }

    const latestUpdates =
      activeSidebarFilter === "duplicate"
        ? rowUpdateTimes.duplicate
        : rowUpdateTimes.unknown;
    const rowIds = new Set(latestUpdates.keys());

    return orderRowsByLatestUpdate(
      specRowSource.filter((r) => rowIds.has(r.id)),
      latestUpdates,
    );
  }, [
    activeSidebarFilter,
    highlightedTableRowIds,
    rowUpdateTimes,
    specRowSource,
  ]);

  const eventGroupFilteredTableRowSource: AnalyticsSpecRow[] | null =
    useMemo(() => {
      if (filteredTableRowSource === null) return null;
      return filteredTableRowSource.filter((row) =>
        doesRowMatchEventGroup(row, activeEventGroupTab, activePlatform),
      );
    }, [activeEventGroupTab, activePlatform, filteredTableRowSource]);

  const tableRows = useMemo(() => {
    const specRows = buildTableRows(
      importResult,
      eventGroupFilteredTableRowSource,
    );
    const shouldShowUnknownRows =
      activeSidebarFilter === "all" || activeSidebarFilter === "unknown";
    const unknownRows = shouldShowUnknownRows
      ? unknownLiveResults
          .filter((result) =>
            doesUnknownResultMatchEventGroup(
              result,
              activeEventGroupTab,
              activePlatform,
            ),
          )
          .map(unknownLiveResultToTableRowModel)
      : [];
    const displayRows = [...specRows, ...unknownRows];
    console.log(
      `[filterResults] activeFilter=${activeSidebarFilter} specRows=${specRows.length} unknownRows=${unknownRows.length} displayRows=${displayRows.length}`,
    );
    return displayRows;
  }, [
    activeEventGroupTab,
    activePlatform,
    activeSidebarFilter,
    eventGroupFilteredTableRowSource,
    importResult,
    unknownLiveResults,
  ]);

  const isImported = importResult !== null;
  const isEmptyImport = isImported && importResult.rows.length === 0;

  const selectedRowDetails = useMemo(() => {
    if (importResult === null) {
      return null;
    }
    if (importResult.rows.length === 0) return null;
    const row = specRowSource?.find((r) => r.id === selectedRowId);
    if (!row) return null;
    const m = specToTableRowModel(row);
    const sourceRow =
      googleSheetSyncMeta?.rows.find((item) => item.rowId === row.id) ?? null;
    const sourceRowNumber =
      sourceRow?.sourceRowNumber ?? getSpecRowSourceRowNumber(row);
    const checkboxColumnIndex = getSelectedGoogleSheetCheckboxColumnIndex(
      googleSheetSyncMeta,
      manualCheckboxColumnInput,
    );
    const writeSheetTitle = getGoogleSheetWriteSheetTitle(googleSheetSyncMeta);
    const expectedRange =
      sourceRowNumber !== null &&
      checkboxColumnIndex !== null &&
      writeSheetTitle !== null
        ? buildGoogleSheetA1Range(
            writeSheetTitle,
            checkboxColumnIndex,
            sourceRowNumber,
          )
        : sourceRow?.googleCheckRange ?? null;
    const rawRow =
      sourceRow?.rawRow && sourceRow.rawRow.length > 0
        ? sourceRow.rawRow
        : getRowMetaStringArray(row, "rawRow");
    const sourcePathColumns =
      sourceRow?.sourcePathColumns && sourceRow.sourcePathColumns.length > 0
        ? sourceRow.sourcePathColumns
        : getRowMetaStringArray(row, "sourcePathColumns");
    return {
      event: m.event,
      statusLabel: m.statusLabel,
      value: m.value,
      description: m.description,
      dotStatus: m.dotStatus,
      sourceRowNumber,
      expectedRange,
      sourcePathColumns,
      rawRowPreview: rawRow
        .map((cell, index) => (cell ? `${columnIndexToA1(index)}=${cell}` : ""))
        .filter(Boolean)
        .slice(0, 12)
        .join(" | "),
    };
  }, [
    googleSheetRowIndex,
    googleSheetSyncMeta,
    importResult,
    manualCheckboxColumnInput,
    selectedRowId,
    specRowSource,
  ]);

  const clearSessionResults = useCallback(() => {
    setMatchBundle(null);
    setProcessMessage(null);
    setActiveSidebarFilter("all");
    setHighlightedMatchResultIds([]);
    setHighlightedTableRowIds([]);
    setRecentResultsScrollSignal(0);
    setTableScrollSignal(0);
    setUnknownLiveResults([]);
    unknownLiveResultsRef.current = [];
    unknownLiveLogIdsRef.current = new Set();
    knownMatchResultIdsRef.current = new Set();
    knownTableLogIdsRef.current = new Set();
    liveDuplicateSeenByEventNameRef.current = new Map();

    for (const timeout of highlightTimeoutsRef.current.values()) {
      window.clearTimeout(timeout);
    }
    highlightTimeoutsRef.current.clear();

    for (const timeout of tableHighlightTimeoutsRef.current.values()) {
      window.clearTimeout(timeout);
    }
    tableHighlightTimeoutsRef.current.clear();
    clearGoogleSheetSyncErrorState();
  }, [clearGoogleSheetSyncErrorState]);

  const clearAndroidLiveContext = useCallback((context: string) => {
    androidLiveContextRef.current += 1;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setLiveFeedLines([]);
    setSelectedLiveFeedLineId(null);
    setAndroidLiveStatus("disconnected");
    setAndroidLiveError(null);
    void stopAndroidBackend(context).then(() =>
      clearAndroidBackendBuffer(context),
    );
  }, []);

  const clearUnityLiveContext = useCallback((context: string) => {
    unityEventSourceRef.current?.close();
    unityEventSourceRef.current = null;
    setUnityLiveFeedLines([]);
    setSelectedUnityLiveFeedLineId(null);
    setUnityLiveStatus("disconnected");
    setUnityLiveError(null);
    void fetch("/api/unity/stop", { method: "POST" })
      .catch((e) => {
        console.warn(`[unity-live] failed to stop backend (${context})`, e);
      })
      .finally(() => {
        void fetch("/api/unity/clear", { method: "POST" }).catch((e) => {
          console.warn(
            `[unity-live] failed to clear backend buffer (${context})`,
            e,
          );
        });
      });
  }, []);

  const clearIosLiveContext = useCallback((context: string) => {
    iosEventSourceRef.current?.close();
    iosEventSourceRef.current = null;
    setIosLiveFeedLines([]);
    setSelectedLiveFeedLineId(null);
    setIosLiveStatus("disconnected");
    setIosLiveError(null);
    void fetch("/api/ios/stop", { method: "POST" })
      .catch((e) => {
        console.warn(`[ios-live] failed to stop backend (${context})`, e);
      })
      .finally(() => {
        void fetch("/api/ios/clear", { method: "POST" }).catch((e) => {
          console.warn(
            `[ios-live] failed to clear backend buffer (${context})`,
            e,
          );
        });
      });
  }, []);

  const clearActivePlatformLiveContext = useCallback(
    (context: string) => {
      const platform = activePlatformRef.current;
      if (platform === "android") {
        clearAndroidLiveContext(context);
        return;
      }
      if (platform === "unity") {
        clearUnityLiveContext(context);
        return;
      }
      clearIosLiveContext(context);
    },
    [clearAndroidLiveContext, clearIosLiveContext, clearUnityLiveContext],
  );

  const handleDetachSpec = useCallback(() => {
    if (
      pendingSheetUpdatesRef.current.size > 0 &&
      !window.confirm(labels.detachSpecConfirm)
    ) {
      return;
    }

    const wasGoogleSheetImport = googleSheetSourceUrl !== null;

    originalWorkbookBufferRef.current = null;
    setImportResult(null);
    importResultRef.current = null;
    setSelectedRowId(null);
    setImportError(null);
    setGoogleSheetError(null);
    setGoogleSheetImportInfo(null);
    setAndroidSpecRequiredError(null);
    clearSessionResults();

    if (wasGoogleSheetImport) {
      setGoogleSheetUrl("");
    }
    setGoogleSheetSourceUrl(null);
    setGoogleSheetSyncMeta(null);
    googleSheetSyncMetaRef.current = null;
    setGoogleSheetRowIndex(null);
    googleSheetRowIndexRef.current = null;
    setGoogleRowIndexStatus("idle");
    googleRowIndexStatusRef.current = "idle";
    setGoogleRowIndexLastError(null);
    googleRowIndexLastErrorRef.current = null;
    setGoogleSheetRowIndexError(null);
    sheetTitleResolveKeyRef.current = null;
    setLastGoogleSheetTestWriteDebugInfo(null);
    setLastXlsxImportDebugInfo(null);
    setManualSheetTitleInput("");
    setManualCheckboxColumnInput(fixedGoogleSheetCheckboxColumnLetter);
    manualCheckboxColumnInputRef.current = fixedGoogleSheetCheckboxColumnLetter;
    manualGoogleSheetSyncSettingsRef.current = {
      ...manualGoogleSheetSyncSettingsRef.current,
      tabKey: null,
      manualSheetTitle: null,
      sheetTitleSource: null,
      manualCheckboxColumnInput: fixedGoogleSheetCheckboxColumnLetter,
      checkboxColumnSource: "fixed",
    };
    setManualCheckboxColumnError(null);
    setPreviewGoogleSheetWriteTargets(false);
    previewGoogleSheetWriteTargetsRef.current = false;
    setAutoUpdateGoogleSheet(false);
    autoUpdateGoogleSheetRef.current = false;
    setAutoUpdateAttemptedWithoutRequirements(false);
    clearGoogleSheetSyncQueue();
  }, [
    clearGoogleSheetSyncQueue,
    clearSessionResults,
    googleSheetSourceUrl,
    labels.detachSpecConfirm,
  ]);

  const handleSpecFile = useCallback(async (file: File) => {
    setIsImporting(true);
    setImportError(null);
    setGoogleSheetError(null);
    setGoogleSheetImportInfo(null);
    try {
      const originalWorkbookBuffer = await file.arrayBuffer();
      const trimmedGoogleSheetUrl = googleSheetUrl.trim();
      const isExcelFile = isExcelWorkbookFile(file);
      const wantsGoogleAttachedXlsx =
        trimmedGoogleSheetUrl.length > 0 && isExcelFile;
      const googleSheetUrlParts =
        wantsGoogleAttachedXlsx
          ? parseGoogleSheetUrlForWriteback(trimmedGoogleSheetUrl)
          : null;
      if (wantsGoogleAttachedXlsx && googleSheetUrlParts === null) {
        throw new Error(labels.google.invalidSheetUrl);
      }
      const shouldAttachGoogleWriteback =
        wantsGoogleAttachedXlsx &&
        googleSheetUrlParts !== null;
      const googleWritebackSheetTitleSource: SheetTitleSource =
        manualSheetTitleInput.trim()
          ? manualGoogleSheetSyncSettingsRef.current.sheetTitleSource ??
            "manual"
          : "default";
      const googleWritebackSheetTitle =
        manualSheetTitleInput.trim() ||
        getDefaultUploadedXlsxGoogleSheetTitle(activePlatform) ||
        defaultAndroidGoogleSheetTabName;
      const parsedWorkbook = parseWorkbookToMatrix(
        originalWorkbookBuffer,
        shouldAttachGoogleWriteback
          ? { sheetName: googleWritebackSheetTitle }
          : {},
      );
      const selectedSheetName =
        parsedWorkbook.debug.sheetFound === false
          ? null
          : parsedWorkbook.debug.usedSheetName || null;
      const xlsxImportDebugLines = shouldAttachGoogleWriteback
        ? [
            `workbook sheets=${JSON.stringify(parsedWorkbook.debug.sheetNames)}`,
            `requestedSheet=${googleWritebackSheetTitle}`,
            `selectedSheet=${selectedSheetName ?? "null"}`,
            `selectedSheetRows=${parsedWorkbook.matrix.length}`,
          ]
        : [];
      if (shouldAttachGoogleWriteback) {
        console.log(
          `[xlsxImport] workbook sheets=${JSON.stringify(
            parsedWorkbook.debug.sheetNames,
          )}`,
        );
        console.log(`[xlsxImport] selectedSheet=${selectedSheetName ?? "null"}`);
        console.log(
          `[xlsxImport] selectedSheetRows=${parsedWorkbook.matrix.length}`,
        );
        if (parsedWorkbook.debug.sheetFound === false) {
          setLastXlsxImportDebugInfo(xlsxImportDebugLines.join("\n"));
          throw new Error(
            labels.google.xlsxSheetNotFound(googleWritebackSheetTitle),
          );
        }
      } else {
        setLastXlsxImportDebugInfo(null);
      }
      const checkboxMatrixForImport = shouldAttachGoogleWriteback
        ? buildFixedGoogleSheetCheckboxMatrixForLocalXlsx(
            parsedWorkbook.matrix,
            parsedWorkbook.checkboxMatrix,
          )
        : parsedWorkbook.checkboxMatrix;
      const importedResult = importSpecFromMatrix(
        parsedWorkbook.matrix,
        checkboxMatrixForImport,
        {
          fileName: file.name,
          fileSize: file.size,
        },
        shouldAttachGoogleWriteback
          ? { checkColumnIndex: fixedGoogleSheetCheckboxColumnIndex }
          : {},
        parsedWorkbook.debug,
      );
      if (shouldAttachGoogleWriteback) {
        xlsxImportDebugLines.push(`parsedRows=${importedResult.rows.length}`);
        console.log(`[xlsxImport] parsedRows=${importedResult.rows.length}`);
        if (importedResult.rows.length === 0) {
          const matrixPreview = formatXlsxMatrixPreview(parsedWorkbook.matrix);
          xlsxImportDebugLines.push(
            `matrixPreview:\n${matrixPreview || "null"}`,
          );
        }
      }
      let res: ParsedSpecResult = shouldAttachGoogleWriteback
        ? {
            ...importedResult,
            warnings: importedResult.warnings.filter(
              (warning) => !isLegacyCheckColumnMissingWarning(warning),
            ),
            debug: {
              ...importedResult.debug,
              sourceGoogleSheetUrl: trimmedGoogleSheetUrl,
              sourceGoogleSheetSpreadsheetId:
                googleSheetUrlParts.spreadsheetId,
              sourceGoogleSheetGid: googleSheetUrlParts.gid,
              sourceGoogleSheetTitle: googleWritebackSheetTitle,
            },
          }
        : importedResult;
      let uploadedXlsxGoogleSyncMeta: GoogleSheetSyncMetadata | null =
        shouldAttachGoogleWriteback
          ? {
              spreadsheetId: googleSheetUrlParts.spreadsheetId,
              gid: googleSheetUrlParts.gid,
              sourceUrl: trimmedGoogleSheetUrl,
              writebackSource: "uploadedXlsx",
              sheetTitle: googleWritebackSheetTitle,
              manualSheetTitle: googleWritebackSheetTitle,
              sheetTitleSource: googleWritebackSheetTitleSource,
              checkboxColumnIndex: fixedGoogleSheetCheckboxColumnIndex,
              statusColumnIndex: null,
              doneColumnIndex: fixedGoogleSheetCheckboxColumnIndex,
              checkColumnIndex: null,
              checkboxColumnSource: "fixed",
              checkboxCandidates: [],
              checkboxColumnDetectionError: null,
              detectedHeaders: parsedWorkbook.matrix[0] ?? [],
              headerRowIndex: null,
              headerRowNumber: null,
              rows: buildGoogleSheetSourceRowsFromParsedRows(
                res.rows,
                googleWritebackSheetTitle,
              ),
              staircaseRows: buildGoogleSheetStaircaseRowsFromMatrix(
                parsedWorkbook.matrix,
              ),
            }
          : null;
      const uploadedXlsxGoogleRowIndex =
        uploadedXlsxGoogleSyncMeta === null
          ? null
          : buildGoogleSheetRowIndexFromSourceMetadata(
              uploadedXlsxGoogleSyncMeta,
            );
      if (shouldAttachGoogleWriteback) {
        const staircaseIndexSize =
          uploadedXlsxGoogleRowIndex?.indexedEventCount ?? 0;
        xlsxImportDebugLines.push(`staircaseIndexSize=${staircaseIndexSize}`);
        console.log(`[xlsxImport] staircaseIndexSize=${staircaseIndexSize}`);
        const rowDebugSample =
          uploadedXlsxGoogleRowIndex?.debugRows
            ?.slice(0, 10)
            .map(
              (row) =>
                `eventName=${row.eventName} sourceRowNumber=${row.rowNumber} range=${row.range ?? "null"} actualColumns=${
                  row.actualColumns.join(",") || "none"
                } leaf=${row.leaf} parent=${row.parent} gValue=${
                  row.gValue || "null"
                } gIsBooleanLike=${row.gIsBooleanLike}`,
            )
            .join("\n") ?? "";
        xlsxImportDebugLines.push(
          `rowDebugSample:\n${rowDebugSample || "null"}`,
        );
        if (staircaseIndexSize <= 0) {
          const matrixPreview = formatXlsxMatrixPreview(parsedWorkbook.matrix);
          xlsxImportDebugLines.push(
            `matrixPreview:\n${matrixPreview || "null"}`,
          );
          setLastXlsxImportDebugInfo(xlsxImportDebugLines.join("\n"));
          throw new Error(
            labels.google.xlsxNoSpecRows(googleWritebackSheetTitle),
          );
        }
        if (uploadedXlsxGoogleRowIndex) {
          const reconstructedRows = buildSpecRowsFromGoogleSheetRowIndex(
            uploadedXlsxGoogleRowIndex,
          );
          xlsxImportDebugLines.push(
            `reconstructedRows=${reconstructedRows.length}`,
          );
          xlsxImportDebugLines.push(`finalRows=${reconstructedRows.length}`);
          console.log(
            `[xlsxImport] reconstructedRows=${reconstructedRows.length}`,
          );
          if (reconstructedRows.length === 0) {
            setLastXlsxImportDebugInfo(xlsxImportDebugLines.join("\n"));
            throw new Error(
              labels.google.xlsxNoSpecRows(googleWritebackSheetTitle),
            );
          }
          res = {
            ...res,
            rows: reconstructedRows,
            warnings:
              reconstructedRows.length === importedResult.rows.length
                ? res.warnings.filter(
                    (warning) => !isLegacyCheckColumnMissingWarning(warning),
                  )
                : [
                    ...res.warnings.filter(
                      (warning) => !isLegacyCheckColumnMissingWarning(warning),
                    ),
                    "Spec rows reconstructed from Google Sheet staircase A:E.",
                  ],
            debug: {
              ...res.debug,
              meaningfulRowCount: reconstructedRows.length,
              specRowCount: reconstructedRows.length,
            },
          };
          uploadedXlsxGoogleSyncMeta = uploadedXlsxGoogleSyncMeta
            ? {
                ...uploadedXlsxGoogleSyncMeta,
                rows: buildGoogleSheetSourceRowsFromParsedRows(
                  reconstructedRows,
                  googleWritebackSheetTitle,
                ),
              }
            : null;
        }
        setLastXlsxImportDebugInfo(xlsxImportDebugLines.join("\n"));
      }
      if (
        trimmedGoogleSheetUrl.length > 0 &&
        isExcelFile &&
        !shouldAttachGoogleWriteback
      ) {
        setGoogleSheetError(labels.google.invalidSheetUrl);
      }
      originalWorkbookBufferRef.current = originalWorkbookBuffer;
      setImportResult(res);
      importResultRef.current = res;
      setGoogleSheetSourceUrl(
        uploadedXlsxGoogleSyncMeta ? trimmedGoogleSheetUrl : null,
      );
      setGoogleSheetSyncMeta(uploadedXlsxGoogleSyncMeta);
      googleSheetSyncMetaRef.current = uploadedXlsxGoogleSyncMeta;
      setAutoUpdateAttemptedWithoutRequirements(false);
      setManualCheckboxColumnError(null);
      setLastGoogleSheetTestWriteDebugInfo(null);
      setGoogleSheetRowIndex(uploadedXlsxGoogleRowIndex);
      googleSheetRowIndexRef.current = uploadedXlsxGoogleRowIndex;
      setGoogleRowIndexStatus(
        uploadedXlsxGoogleSyncMeta
          ? uploadedXlsxGoogleRowIndex
            ? "ready"
            : "failed"
          : "idle",
      );
      googleRowIndexStatusRef.current = uploadedXlsxGoogleSyncMeta
        ? uploadedXlsxGoogleRowIndex
          ? "ready"
          : "failed"
        : "idle";
      setGoogleRowIndexLastError(null);
      googleRowIndexLastErrorRef.current = null;
      setGoogleSheetRowIndexError(null);
      sheetTitleResolveKeyRef.current = null;
      clearGoogleSheetSyncQueue();
      if (uploadedXlsxGoogleSyncMeta) {
        setManualSheetTitleInput(googleWritebackSheetTitle);
        setManualCheckboxColumnInput(fixedGoogleSheetCheckboxColumnLetter);
        manualCheckboxColumnInputRef.current =
          fixedGoogleSheetCheckboxColumnLetter;
        manualGoogleSheetSyncSettingsRef.current = {
          tabKey: getGoogleSheetTabKey(uploadedXlsxGoogleSyncMeta),
          manualSheetTitle: googleWritebackSheetTitle,
          sheetTitleSource: googleWritebackSheetTitleSource,
          manualCheckboxColumnInput: fixedGoogleSheetCheckboxColumnLetter,
          checkboxColumnSource: "fixed",
        };
        setGoogleSheetImportInfo(
          labels.google.uploadedXlsxGoogleSyncLoaded,
        );
        setSheetSyncStatus("idle");
        setSheetSyncError(
          uploadedXlsxGoogleRowIndex
            ? labels.google.syncReady
            : labels.google.rowIndexFailed,
        );
        setAutoUpdateGoogleSheet(googleAuthStatus.connected);
        autoUpdateGoogleSheetRef.current = googleAuthStatus.connected;
      } else {
        setSheetSyncStatus("idle");
        setSheetSyncError(null);
        setAutoUpdateGoogleSheet(false);
        autoUpdateGoogleSheetRef.current = false;
      }
      setAndroidSpecRequiredError(null);
      clearSessionResults();
      setSelectedRowId(null);
      clearActivePlatformLiveContext("spec change");
    } catch (e) {
      setImportError(e instanceof Error ? e.message : labels.importFailed);
    } finally {
      setIsImporting(false);
    }
  }, [
    clearActivePlatformLiveContext,
    clearGoogleSheetSyncQueue,
    clearSessionResults,
    activePlatform,
    googleAuthStatus.connected,
    googleSheetUrl,
    labels,
    manualSheetTitleInput,
  ]);

  const clearGoogleSheetImportRetryTimer = useCallback(() => {
    if (googleSheetImportRetryTimerRef.current !== null) {
      window.clearTimeout(googleSheetImportRetryTimerRef.current);
      googleSheetImportRetryTimerRef.current = null;
    }
    setNextGoogleSheetImportRetryAt(null);
    setNextGoogleSheetImportRetrySeconds(null);
  }, []);

  const clearGoogleSheetImportClientTimers = useCallback(
    (request: GoogleSheetImportClientRequest | null) => {
      if (!request) {
        return;
      }
      if (request.slowHintTimerId !== null) {
        window.clearTimeout(request.slowHintTimerId);
      }
      if (request.stillRunningHintTimerId !== null) {
        window.clearTimeout(request.stillRunningHintTimerId);
      }
    },
    [],
  );

  const handleClearLocalAppState = useCallback(() => {
    if (!window.confirm(labels.google.clearLocalAppStateConfirm)) {
      return;
    }

    const activeImportRequest = activeGoogleSheetImportRequestRef.current;
    if (activeImportRequest) {
      activeGoogleSheetImportRequestRef.current = null;
      clearGoogleSheetImportClientTimers(activeImportRequest);
      activeImportRequest.controller.abort();
    }
    clearGoogleSheetImportRetryTimer();

    try {
      window.localStorage.clear();
      window.sessionStorage.clear();
    } catch (error) {
      console.warn("[local-state] failed to clear browser storage", error);
    }

    platformWorkspacesRef.current = createDefaultPlatformWorkspaces();
    originalWorkbookBufferRef.current = null;
    importResultRef.current = null;
    googleSheetSyncMetaRef.current = null;
    googleSheetRowIndexRef.current = null;
    pendingSheetUpdatesRef.current.clear();
    skippedGoogleSheetWritebacksRef.current.clear();
    syncedGoogleSheetRowIdsRef.current.clear();
    sheetSyncSeenLogIdsRef.current.clear();
    lastWritebackLookupFailureRef.current = null;
    manualGoogleSheetSyncSettingsRef.current =
      createDefaultManualGoogleSheetSyncSettings();
    manualCheckboxColumnInputRef.current = fixedGoogleSheetCheckboxColumnLetter;
    autoUpdateGoogleSheetRef.current = false;
    previewGoogleSheetWriteTargetsRef.current = false;
    sheetTitleResolveKeyRef.current = null;
    sheetSyncRetryAttemptRef.current = 0;
    googleSheetRowIndexRetryAttemptRef.current = 0;
    googleSheetTitleRetryAttemptRef.current = 0;
    googleSheetRowIndexNetworkIssueRef.current = false;
    googleSheetSyncMappingIssueRef.current = false;
    liveDuplicateSeenByEventNameRef.current = new Map();

    setImportResult(null);
    setSelectedRowId(null);
    setImportError(null);
    setGoogleSheetUrl("");
    setGoogleSheetError(null);
    setGoogleSheetImportInfo(labels.google.localAppStateCleared);
    setGoogleSheetImportErrorDebug(null);
    setLastXlsxImportDebugInfo(null);
    setGoogleSheetSourceUrl(null);
    setGoogleSheetSyncMeta(null);
    setGoogleSheetRowIndex(null);
    setGoogleRowIndexStatus("idle");
    googleRowIndexStatusRef.current = "idle";
    setGoogleRowIndexLastError(null);
    googleRowIndexLastErrorRef.current = null;
    setGoogleSheetRowIndexError(null);
    setManualSheetTitleInput("");
    setManualCheckboxColumnInput(fixedGoogleSheetCheckboxColumnLetter);
    setManualCheckboxColumnError(null);
    setPreviewGoogleSheetWriteTargets(false);
    setAutoUpdateGoogleSheet(false);
    setAutoUpdateAttemptedWithoutRequirements(false);
    setGoogleSheetWriteTargetPreview([]);
    setLastGoogleSheetTestWriteDebugInfo(null);
    setLastGoogleSheetMappingDebugInfo(null);
    setLastGoogleSheetTargetRange(null);
    setSkippedGoogleSheetWritebacks([]);
    setPendingSheetUpdateCount(0);
    setLastWritebackLookupFailure(null);
    setSavedAndroidPackageNames([]);
    setAndroidPackageName("");
    setAndroidPackageDetectError(null);
    setAndroidSpecRequiredError(null);
    setActiveSidebarFilter("all");
    setActiveEventGroupTab("all");
    setLogText("");
    setUnityManualEventInput("");
    setUnityShowAllLogLines(true);

    clearGoogleSheetSyncQueue();
    clearSessionResults();
    clearAndroidLiveContext("clear local app state");
    clearIosLiveContext("clear local app state");
    clearUnityLiveContext("clear local app state");
    setSheetSyncStatus("idle");
    setSheetSyncError(labels.google.localAppStateCleared);
  }, [
    clearAndroidLiveContext,
    clearIosLiveContext,
    clearUnityLiveContext,
    clearGoogleSheetImportClientTimers,
    clearGoogleSheetImportRetryTimer,
    clearGoogleSheetSyncQueue,
    clearSessionResults,
    labels.google.clearLocalAppStateConfirm,
    labels.google.localAppStateCleared,
  ]);

  const handleGoogleSheetImportCancel = useCallback(() => {
    const request = activeGoogleSheetImportRequestRef.current;
    if (!request) {
      return;
    }
    clearGoogleSheetImportRetryTimer();
    activeGoogleSheetImportRequestRef.current = null;
    clearGoogleSheetImportClientTimers(request);
    request.controller.abort();
    setIsImportingGoogleSheet(false);
    setGoogleSheetError(null);
    setGoogleSheetImportInfo(labels.google.importCancelled);
    console.log(
      `[googleSheetImportClient] cancelled requestId=${request.requestId}`,
    );
  }, [
    clearGoogleSheetImportClientTimers,
    clearGoogleSheetImportRetryTimer,
    labels.google.importCancelled,
  ]);

  const handleGoogleSheetImport = useCallback(async (retryAttempt = 0) => {
    if (isImportingRef.current || isImportingGoogleSheetRef.current) {
      return;
    }

    if (retryAttempt === 0) {
      clearGoogleSheetImportRetryTimer();
    }

    const trimmedUrl = googleSheetUrl.trim();
    if (!trimmedUrl) {
      setGoogleSheetError(labels.google.sheetUrlRequired);
      setGoogleSheetImportErrorDebug({
        importErrorType: "invalid-url",
        importTechnicalDetail: labels.google.sheetUrlRequired,
      });
      return;
    }

    const requestId = googleSheetImportRequestSeqRef.current + 1;
    googleSheetImportRequestSeqRef.current = requestId;
    const controller = new AbortController();
    setIsImportingGoogleSheet(true);
    setGoogleSheetError(null);
    setGoogleSheetImportInfo(null);
    setGoogleSheetImportErrorDebug(null);
    setImportError(null);
    setLastXlsxImportDebugInfo(null);
    const totalStartedAt = Date.now();
    const googleSheetUrlPartsForImport =
      parseGoogleSheetUrlForWriteback(trimmedUrl);
    const importTabKeyFromUrl = googleSheetUrlPartsForImport
      ? getGoogleSheetTabKey(googleSheetUrlPartsForImport)
      : null;
    const previousSyncMetaForImport = googleSheetSyncMetaRef.current;
    const previousManualSettingsForImport =
      manualGoogleSheetSyncSettingsRef.current;
    const previousTabKeyForImport =
      getGoogleSheetTabKey(previousSyncMetaForImport) ??
      previousManualSettingsForImport.tabKey;
    const previousTitleSourceForImport =
      getGoogleSheetTitleSource(previousSyncMetaForImport) ??
      previousManualSettingsForImport.sheetTitleSource ??
      null;
    const isSameGoogleSheetTabForImport =
      importTabKeyFromUrl !== null &&
      importTabKeyFromUrl === previousTabKeyForImport;
    let manualSheetTitleForImport =
      isSameGoogleSheetTabForImport &&
      previousTitleSourceForImport === "manual"
        ? manualSheetTitleInput.trim() ||
          previousSyncMetaForImport?.manualSheetTitle?.trim() ||
          previousManualSettingsForImport.manualSheetTitle ||
          null
        : null;
    let sheetTitleSourceForImport: SheetTitleSource =
      manualSheetTitleForImport ? "manual" : "default";
    let sheetTitleResolutionErrorForImport: string | null = null;
    let canUseDefaultSheetTitleForImport = true;
    const requestStartedAt = Date.now();
    console.log(`[googleSheetImportClient] start requestId=${requestId}`);
    console.log("[googleSheetImportClient] requestTimeoutMs=none");
    console.log("[googleSheetImportPerf] download start");
    const slowHintTimerId = window.setTimeout(() => {
      if (activeGoogleSheetImportRequestRef.current?.requestId !== requestId) {
        return;
      }
      console.log(
        `[googleSheetImportClient] still running after 20s requestId=${requestId}`,
      );
      setGoogleSheetImportInfo(labels.google.importSlowHint);
    }, googleSheetImportSlowHintDelayMs);
    const stillRunningHintTimerId = window.setTimeout(() => {
      if (activeGoogleSheetImportRequestRef.current?.requestId !== requestId) {
        return;
      }
      console.log(
        `[googleSheetImportClient] still running after 60s requestId=${requestId}`,
      );
      setGoogleSheetImportInfo(labels.google.importStillRunningHint);
    }, googleSheetImportStillRunningHintDelayMs);
    activeGoogleSheetImportRequestRef.current = {
      requestId,
      controller,
      slowHintTimerId,
      stillRunningHintTimerId,
    };
    try {
      if (
        manualSheetTitleForImport === null &&
        googleAuthStatus.connected &&
        googleSheetUrlPartsForImport?.spreadsheetId &&
        googleSheetUrlPartsForImport.gid
      ) {
        try {
          console.log(
            `[googleSheetTitle] resolveStart gid=${googleSheetUrlPartsForImport.gid}`,
          );
          const titleResponse = await fetch("/api/google-sheet/title", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              spreadsheetId: googleSheetUrlPartsForImport.spreadsheetId,
              gid: googleSheetUrlPartsForImport.gid,
            }),
          });
          const titlePayload = (await titleResponse.json().catch(() => null)) as
            | {
                success?: boolean;
                sheetTitle?: unknown;
                error?: string;
                technicalDetail?: string;
                networkIssue?: boolean;
              }
            | null;
          if (!titleResponse.ok || !titlePayload?.success) {
            const errorMessage =
              titlePayload?.error ??
              unresolvedGoogleSheetTabMessage(googleSheetUrlPartsForImport.gid);
            const technicalDetail = titlePayload?.technicalDetail?.trim();
            const titleError = new Error(
              technicalDetail && !errorMessage.includes(technicalDetail)
                ? `${errorMessage} ${technicalDetail}`
                : errorMessage,
            ) as Error & { networkIssue?: boolean; status?: number };
            titleError.networkIssue =
              Boolean(titlePayload?.networkIssue) ||
              titleResponse.status === 503;
            titleError.status = titleResponse.status;
            throw titleError;
          }
          if (
            typeof titlePayload.sheetTitle !== "string" ||
            !titlePayload.sheetTitle.trim()
          ) {
            throw new Error(
              unresolvedGoogleSheetTabMessage(googleSheetUrlPartsForImport.gid),
            );
          }
          if (
            activeGoogleSheetImportRequestRef.current?.requestId !== requestId
          ) {
            console.log(
              `[googleSheetImportClient] ignored stale response requestId=${requestId}`,
            );
            return;
          }
          manualSheetTitleForImport = titlePayload.sheetTitle.trim();
          sheetTitleSourceForImport = "auto-detected";
          sheetTitleResolutionErrorForImport = null;
          setManualSheetTitleInput(manualSheetTitleForImport);
          setGoogleSheetImportInfo(labels.google.sheetTabDetectedAutomatically);
          manualGoogleSheetSyncSettingsRef.current = {
            ...manualGoogleSheetSyncSettingsRef.current,
            tabKey:
              importTabKeyFromUrl ??
              manualGoogleSheetSyncSettingsRef.current.tabKey,
            manualSheetTitle: manualSheetTitleForImport,
            sheetTitleSource: "auto-detected",
          };
          console.log(
            `[googleSheetTitle] resolvedSheetTitle=${manualSheetTitleForImport}`,
          );
        } catch (titleError) {
          if (
            activeGoogleSheetImportRequestRef.current?.requestId !== requestId
          ) {
            console.log(
              `[googleSheetImportClient] ignored stale response requestId=${requestId}`,
            );
            return;
          }
          const message =
            titleError instanceof Error
              ? titleError.message
              : unresolvedGoogleSheetTabMessage(
                  googleSheetUrlPartsForImport.gid,
                );
          const isNetworkIssue =
            Boolean(
              (titleError as { networkIssue?: boolean } | null)?.networkIssue,
            ) || isGoogleSheetNetworkIssueMessage(message);
          sheetTitleResolutionErrorForImport = message;
          console.warn(
            `[googleSheetTitle] resolveFailed gid=${googleSheetUrlPartsForImport.gid} error=${message}`,
          );
          setLastGoogleSheetMappingDebugInfo((current) =>
            [
              `Google Sheet title warning: ${message}`,
              ...(current?.split("\n") ?? []),
            ]
              .slice(0, 5)
              .join("\n"),
          );
          if (!isNetworkIssue) {
            manualSheetTitleForImport = null;
            canUseDefaultSheetTitleForImport = false;
          }
        }
      }

      if (
        manualSheetTitleForImport === null &&
        canUseDefaultSheetTitleForImport
      ) {
        manualSheetTitleForImport =
          getDefaultGoogleSheetManualTitle(activePlatform) || null;
        sheetTitleSourceForImport = manualSheetTitleForImport
          ? "default"
          : sheetTitleSourceForImport;
      }

      const response = await fetch("/api/google-sheet/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          url: trimmedUrl,
          manualSheetTitle: manualSheetTitleForImport,
          selectedPlatform: activePlatform,
          fallbackSheetTitle: getDefaultUploadedXlsxGoogleSheetTitle(
            activePlatform,
          ),
        }),
      });
      const downloadDurationMs = Date.now() - requestStartedAt;
      console.log(`[googleSheetImportPerf] downloadMs=${downloadDurationMs}`);
      console.log(
        `[googleSheetImportPerf] download success durationMs=${downloadDurationMs}`,
      );
      const payload = (await response
        .json()
        .catch(() => null)) as GoogleSheetImportResponse | null;

      if (
        activeGoogleSheetImportRequestRef.current?.requestId !== requestId
      ) {
        console.log(
          `[googleSheetImportClient] ignored stale response requestId=${requestId}`,
        );
        return;
      }

      if (!payload || !payload.success) {
        const errorMessage =
          payload?.error ??
          `${labels.google.importFailed}: HTTP ${response.status}`;
        const technicalDetail = payload?.technicalDetail?.trim();
        const importErrorType = classifyGoogleSheetImportClientError({
          message: errorMessage,
          status: response.status,
          technicalDetail,
          networkIssue: payload?.networkIssue,
          importErrorType: payload?.importErrorType,
        });
        const importError = new Error(
          technicalDetail && !errorMessage.includes(technicalDetail)
            ? `${errorMessage} ${technicalDetail}`
            : errorMessage,
        ) as GoogleSheetImportClientError;
        importError.importErrorType = importErrorType;
        importError.networkIssue =
          importErrorType === "network" || Boolean(payload?.networkIssue);
        importError.status = response.status;
        importError.technicalDetail = technicalDetail ?? null;
        throw importError;
      }

      console.log(
        `[googleSheetImportClient] success requestId=${requestId} durationMs=${
          Date.now() - requestStartedAt
        }`,
      );
      setGoogleSheetImportInfo(null);
      const sourceUrl = payload.sourceUrl.trim() || trimmedUrl;
      const originalWorkbookBuffer = base64ToArrayBuffer(
        payload.workbookBase64,
      );
      const syncSheetTitle = payload.sync?.sheetTitle?.trim() || null;
      const syncGid = payload.sync?.gid?.trim() || payload.gid;
      const syncSpreadsheetId =
        payload.sync?.spreadsheetId?.trim() || payload.spreadsheetId.trim();
      const previousSyncMeta = googleSheetSyncMetaRef.current;
      const previousManualSettings =
        manualGoogleSheetSyncSettingsRef.current;
      const importedTabKey = getGoogleSheetTabKey({
        spreadsheetId: syncSpreadsheetId,
        gid: syncGid,
      });
      const previousTabKey =
        getGoogleSheetTabKey(previousSyncMeta) ?? previousManualSettings.tabKey;
      const isSameGoogleSheetTab =
        importedTabKey !== null && importedTabKey === previousTabKey;
      const previousTitleSource =
        getGoogleSheetTitleSource(previousSyncMeta) ??
        previousManualSettings.sheetTitleSource ??
        null;
      const preservedManualSheetTitle =
        isSameGoogleSheetTab && previousTitleSource === "manual"
          ? previousSyncMeta?.manualSheetTitle?.trim() ||
            previousManualSettings.manualSheetTitle
          : null;
      const savedResolvedSheetTitle =
        syncSheetTitle ?? manualSheetTitleForImport ?? null;
      const savedSheetTitleSource: SheetTitleSource =
        preservedManualSheetTitle !== null
          ? "manual"
          : sheetTitleSourceForImport === "auto-detected"
            ? "auto-detected"
            : syncSheetTitle && manualSheetTitleForImport === null
              ? "auto-detected"
              : "default";
      const displayName = googleSheetDisplayName(
        savedResolvedSheetTitle,
        syncGid,
      );
      const result: ParsedSpecResult = {
        ...payload.result,
        debug: {
          ...payload.result.debug,
          fileName: displayName,
          sourceGoogleSheetUrl: sourceUrl,
          sourceGoogleSheetSpreadsheetId: payload.spreadsheetId,
          sourceGoogleSheetGid: payload.gid,
          sourceGoogleSheetTitle: savedResolvedSheetTitle,
        },
      };
      const savedGoogleSheetSyncMeta = payload.sync
        ? (() => {
            const baseMeta: GoogleSheetSyncMetadata = {
              ...payload.sync,
              spreadsheetId: syncSpreadsheetId,
              gid: syncGid,
              sourceUrl: payload.sync.sourceUrl?.trim() || sourceUrl,
              writebackSource: "googleSheetImport",
              sheetTitle: savedResolvedSheetTitle,
              manualSheetTitle:
                preservedManualSheetTitle ?? savedResolvedSheetTitle,
              sheetTitleSource: savedSheetTitleSource,
              checkboxColumnIndex: fixedGoogleSheetCheckboxColumnIndex,
              statusColumnIndex: payload.sync.statusColumnIndex ?? null,
              doneColumnIndex: fixedGoogleSheetCheckboxColumnIndex,
              checkboxColumnSource: "fixed",
              checkboxCandidates: payload.sync.checkboxCandidates ?? [],
              checkboxColumnDetectionError: null,
              detectedHeaders: payload.sync.detectedHeaders ?? [],
              sheetTitleResolutionError:
                savedSheetTitleSource === "auto-detected" &&
                savedResolvedSheetTitle
                  ? null
                  : sheetTitleResolutionErrorForImport ??
                    payload.sync.sheetTitleResolutionError?.trim() ??
                    null,
            };
            return baseMeta;
          })()
        : null;

      const rowIndexBuildStartedAt = Date.now();
      setGoogleRowIndexStatus(savedGoogleSheetSyncMeta ? "building" : "idle");
      googleRowIndexStatusRef.current = savedGoogleSheetSyncMeta
        ? "building"
        : "idle";
      setGoogleRowIndexLastError(null);
      googleRowIndexLastErrorRef.current = null;
      const importedGoogleSheetRowIndex =
        buildGoogleSheetRowIndexFromSourceMetadata(savedGoogleSheetSyncMeta);
      console.log(
        `[googleSheetImportPerf] rowIndexBuildMs=${
          Date.now() - rowIndexBuildStartedAt
        }`,
      );
      if (importedGoogleSheetRowIndex) {
        setGoogleRowIndexStatus("ready");
        googleRowIndexStatusRef.current = "ready";
        setGoogleRowIndexLastError(null);
        googleRowIndexLastErrorRef.current = null;
        logGoogleSheetRowIndexDiagnostics(importedGoogleSheetRowIndex);
      } else if (savedGoogleSheetSyncMeta) {
        const sourceBuildError = labels.google.rowIndexFailed;
        setGoogleRowIndexStatus("failed");
        googleRowIndexStatusRef.current = "failed";
        setGoogleRowIndexLastError(sourceBuildError);
        googleRowIndexLastErrorRef.current = sourceBuildError;
      }
      console.log(
        `[googleSheetImportUI] payload.sync=${JSON.stringify(
          payload.sync ?? null,
        )}`,
      );
      console.log(
        `[googleSheetImportUI] googleAuthConnected=${googleAuthStatus.connected}`,
      );
      console.log(
        `[googleSheetImportUI] saved googleSheetSyncMeta=${JSON.stringify(
          savedGoogleSheetSyncMeta,
        )}`,
      );

      const stateUpdateStartedAt = Date.now();
      clearGoogleSheetSyncQueue();
      originalWorkbookBufferRef.current = originalWorkbookBuffer;
      setImportResult(result);
      setGoogleSheetSourceUrl(sourceUrl);
      setAutoUpdateAttemptedWithoutRequirements(false);
      sheetTitleResolveKeyRef.current = null;
      setGoogleSheetSyncMeta(savedGoogleSheetSyncMeta);
      googleSheetSyncMetaRef.current = savedGoogleSheetSyncMeta;
      setGoogleSheetRowIndex(importedGoogleSheetRowIndex);
      googleSheetRowIndexRef.current = importedGoogleSheetRowIndex;
      setGoogleSheetRowIndexError(null);
      const importedManualCheckboxColumnLetter =
        fixedGoogleSheetCheckboxColumnLetter;
      setManualCheckboxColumnInput(importedManualCheckboxColumnLetter);
      manualCheckboxColumnInputRef.current = importedManualCheckboxColumnLetter;
      setManualCheckboxColumnError(null);
      setManualSheetTitleInput(
        savedGoogleSheetSyncMeta?.manualSheetTitle?.trim() || "",
      );
      manualGoogleSheetSyncSettingsRef.current = {
        tabKey: importedTabKey,
        manualSheetTitle:
          savedGoogleSheetSyncMeta?.manualSheetTitle?.trim() || null,
        sheetTitleSource: savedGoogleSheetSyncMeta?.sheetTitleSource ?? null,
        manualCheckboxColumnInput: importedManualCheckboxColumnLetter,
        checkboxColumnSource: "fixed",
      };
      setGoogleSheetImportInfo(
        savedGoogleSheetSyncMeta?.sheetTitleSource === "auto-detected"
          ? labels.google.sheetTabDetectedAutomatically
          : null,
      );
      setLastGoogleSheetTestWriteDebugInfo(null);
      setAndroidSpecRequiredError(null);
      clearSessionResults();
      setSelectedRowId(null);
      clearActivePlatformLiveContext("spec change");
      setSheetSyncStatus("idle");
      setSheetSyncError(
        savedGoogleSheetSyncMeta
          ? importedGoogleSheetRowIndex
            ? labels.google.syncReady
            : labels.google.rowIndexFailed
          : labels.google.specLoaded,
      );
      console.log(
        `[googleSheetImportPerf] stateUpdateMs=${
          Date.now() - stateUpdateStartedAt
        }`,
      );
      console.log(
        `[googleSheetImportPerf] totalFastImportMs=${Date.now() - totalStartedAt}`,
      );
      console.log(
        `[googleSheetImportPerf] totalMs=${Date.now() - totalStartedAt}`,
      );

      void refreshGoogleAuthStatus()
        .catch((error) => {
          console.warn("[googleSheetImportUI] auth refresh after import failed", error);
          if (savedGoogleSheetSyncMeta && !importedGoogleSheetRowIndex) {
            setGoogleRowIndexStatus("failed");
            googleRowIndexStatusRef.current = "failed";
            const message =
              error instanceof Error ? error.message : labels.google.rowIndexFailed;
            setGoogleRowIndexLastError(message);
            googleRowIndexLastErrorRef.current = message;
            setSheetSyncError(`${labels.google.rowIndexFailed}: ${message}`);
          }
        });
    } catch (e) {
      if (activeGoogleSheetImportRequestRef.current?.requestId !== requestId) {
        console.log(
          `[googleSheetImportClient] ignored stale response requestId=${requestId}`,
        );
        return;
      }
      const message =
        e instanceof Error ? e.message : labels.google.importFailed;
      const technicalDetail =
        (e as GoogleSheetImportClientError | null)?.technicalDetail?.trim() ||
        message;
      const importErrorType = classifyGoogleSheetImportClientError({
        message,
        status: (e as GoogleSheetImportClientError | null)?.status ?? null,
        technicalDetail,
        networkIssue: Boolean(
          (e as GoogleSheetImportClientError | null)?.networkIssue,
        ),
        importErrorType: (e as GoogleSheetImportClientError | null)
          ?.importErrorType,
      });
      console.log(
        `[googleSheetImportClient] failed requestId=${requestId} error=${message}`,
      );
      console.log(`[googleSheetImportClient] importErrorType=${importErrorType}`);
      console.log(
        `[googleSheetImportClient] importTechnicalDetail=${technicalDetail}`,
      );
      setGoogleSheetImportErrorDebug({
        importErrorType,
        importTechnicalDetail: technicalDetail,
      });
      setGoogleSheetError(
        localizeGoogleSheetImportError(
          message,
          labels.google,
          importErrorType,
        ),
      );
      const retryDelayMs =
        importErrorType === "network"
          ? googleSheetImportRetryDelayMs[retryAttempt] ?? null
          : null;
      if (retryDelayMs !== null) {
        const retryAt = Date.now() + retryDelayMs;
        const retrySeconds = Math.ceil(retryDelayMs / 1000);
        setGoogleSheetImportInfo(labels.google.importNetworkRetry);
        setNextGoogleSheetImportRetryAt(retryAt);
        setNextGoogleSheetImportRetrySeconds(retrySeconds);
        console.log(
          `[googleSheetImportClient] retry scheduled requestId=${requestId} retryInSeconds=${retrySeconds}`,
        );
        googleSheetImportRetryTimerRef.current = window.setTimeout(() => {
          googleSheetImportRetryTimerRef.current = null;
          setNextGoogleSheetImportRetryAt(null);
          setNextGoogleSheetImportRetrySeconds(null);
          if (activeGoogleSheetImportRequestRef.current !== null) {
            return;
          }
          void handleGoogleSheetImport(retryAttempt + 1);
        }, retryDelayMs);
      } else {
        setGoogleSheetImportInfo(null);
        setNextGoogleSheetImportRetryAt(null);
        setNextGoogleSheetImportRetrySeconds(null);
      }
      console.log(
        `[googleSheetImportPerf] download failed durationMs=${
          Date.now() - requestStartedAt
        } error=${message}`,
      );
      console.log(
        `[googleSheetImportPerf] totalMs=${Date.now() - totalStartedAt}`,
      );
    } finally {
      const activeRequest = activeGoogleSheetImportRequestRef.current;
      if (activeRequest?.requestId === requestId) {
        clearGoogleSheetImportClientTimers(activeRequest);
        activeGoogleSheetImportRequestRef.current = null;
        setIsImportingGoogleSheet(false);
      }
    }
  }, [
    clearActivePlatformLiveContext,
    clearGoogleSheetSyncQueue,
    clearSessionResults,
    clearGoogleSheetImportClientTimers,
    clearGoogleSheetImportRetryTimer,
    activePlatform,
    googleAuthStatus.connected,
    googleSheetUrl,
    labels.google,
    manualSheetTitleInput,
    refreshGoogleAuthStatus,
  ]);

  const getCoverageDebugGoogleTargetRange = useCallback(
    (eventName: string): string | null => {
      const meta = googleSheetSyncMetaRef.current;
      const rowIndex = googleSheetRowIndexRef.current;
      const writeSheetTitle = getGoogleSheetWriteSheetTitle(meta);
      const checkboxColumnIndex = getSelectedGoogleSheetCheckboxColumnIndex(
        meta,
        manualCheckboxColumnInputRef.current,
      );
      if (
        meta === null ||
        rowIndex === null ||
        writeSheetTitle === null ||
        checkboxColumnIndex === null ||
        !isGoogleSheetRowIndexReadyForMeta(rowIndex, meta)
      ) {
        return null;
      }

      const target = getGoogleSheetRowIndexWriteTarget(rowIndex, eventName);
      return target.rowNumber === null
        ? null
        : buildGoogleSheetA1Range(
            writeSheetTitle,
            checkboxColumnIndex,
            target.rowNumber,
          );
    },
    [],
  );

  const logCoverageDebugForPassedLog = useCallback(
    (
      log: ParsedLogEntry,
      rows: AnalyticsSpecRow[],
      allLogs: ParsedLogEntry[],
    ) => {
      if (log.matchType !== "passed") {
        return;
      }
      const eventName = getPassedLogGoogleSheetEventName(log);
      const matchedRowIds = allLogs
        .filter((entry) => entry.matchType === "passed" && entry.matchedRowId)
        .map((entry) => entry.matchedRowId as string);
      const uniquePassedRowIds = Array.from(new Set(matchedRowIds));
      const recentResultsRowIds = allLogs
        .map((entry) => entry.matchedRowId)
        .filter((rowId): rowId is string => rowId !== null);
      const matchedRow =
        log.matchedRowId === null
          ? undefined
          : rows.find((row) => row.id === log.matchedRowId);
      const sourceRowNumber =
        matchedRow === undefined ? null : getSpecRowSourceRowNumber(matchedRow);
      const googleTargetRange =
        eventName === ""
          ? null
          : getCoverageDebugGoogleTargetRange(eventName);

      console.log(`[coverageDebug] event=${eventName || "null"}`);
      console.log(`[coverageDebug] matchType=${log.matchType}`);
      console.log(`[coverageDebug] matchedRowId=${log.matchedRowId ?? "null"}`);
      console.log(
        `[coverageDebug] matchedRowIds=${formatCoverageDebugList(
          uniquePassedRowIds,
        )}`,
      );
      console.log(
        `[coverageDebug] sourceRowNumber=${sourceRowNumber ?? "null"}`,
      );
      console.log(
        `[coverageDebug] googleTargetRange=${googleTargetRange ?? "null"}`,
      );
      console.log(
        `[coverageDebug] uniquePassedRowIdsCount=${uniquePassedRowIds.length}`,
      );
      console.log(
        `[coverageDebug] passedRowIds=${formatCoverageDebugList(
          uniquePassedRowIds,
        )}`,
      );
      console.log(
        `[coverageDebug] recentResultsRowIds=${formatCoverageDebugList(
          recentResultsRowIds,
        )}`,
      );
    },
    [getCoverageDebugGoogleTargetRange],
  );

  const handleProcess = useCallback(() => {
    if (!importResult?.rows.length || !logText.trim()) {
      return;
    }
    setMatchBundle((prev) => {
      const baseRows = prev?.rows ?? importResult.rows;
      const batch = matchLogLinesAgainstSpec(logText, baseRows);
      const logs = [...(prev?.logs ?? []), ...batch.logs];
      const stats = computeStats(batch.rows, logs);
      for (const log of batch.logs) {
        logCoverageDebugForPassedLog(log, batch.rows, logs);
      }
      return { logs, rows: batch.rows, stats };
    });
    setProcessMessage(null);
  }, [importResult, logCoverageDebugForPassedLog, logText]);

  const appendLiveAnalyticsLine = useCallback((rawLine: string, options: LiveAnalyticsLineOptions = {}) => {
    console.log("[live][append] rawLine:", rawLine);
    const spec = importResultRef.current;
    if (!spec?.rows.length) {
      return;
    }
    const trimmed = rawLine.trim();
    if (!trimmed) {
      return;
    }

    const extracted = extractLiveAnalyticsPayload(rawLine);
    const cleanedExtracted =
      extracted === null ? null : finalizeLivePayload(extracted);
    console.log("[live][append] extracted payload:", cleanedExtracted);
    if (cleanedExtracted === null) {
      console.log("LIVE_MATCH_SKIP: payload is null");
      return;
    }
    const normalizedCandidate =
      normalizeAnalyticsEventCandidate(cleanedExtracted);
    console.log(
      `[eventNormalize] raw=${JSON.stringify(
        normalizedCandidate.raw,
      )} normalized=${JSON.stringify(normalizedCandidate.normalized)} format=${
        normalizedCandidate.format
      }`,
    );

    const timestamp = Date.now();
    const duplicateEventName = liveDuplicateEventName(
      normalizedCandidate.normalized,
    );
    const lastSeen =
      duplicateEventName === null
        ? undefined
        : liveDuplicateSeenByEventNameRef.current.get(duplicateEventName);
    const duplicateDeltaMs =
      lastSeen === undefined ? null : timestamp - lastSeen.lastSeenAt;
    const isShortDuplicate =
      duplicateDeltaMs !== null &&
      duplicateDeltaMs >= 0 &&
      duplicateDeltaMs <= duplicateWindowMs;

    setMatchBundle((prev) => {
      let rows: AnalyticsSpecRow[];
      let logs: ParsedLogEntry[];

      if (prev === null) {
        const empty = matchLogLinesAgainstSpec("", spec.rows);
        rows = empty.rows;
        logs = [...empty.logs];
      } else {
        rows = cloneSpecRowsForLiveUpdate(prev.rows);
        logs = [...prev.logs];
      }

      const idx = buildMatcherIndexes(rows);
      const payloadCheck = validateExtractedPayload(
        normalizedCandidate.normalized,
      );
      const allowSingleSegmentPayload =
        options.allowSingleSegmentPayload === true &&
        normalizedCandidate.normalized.split(".").filter(Boolean).length === 1;
      if (!payloadCheck.valid && !allowSingleSegmentPayload) {
        const matchType = isShortDuplicate ? "duplicate" : "unknown";
        const reason = isShortDuplicate
          ? "Duplicate event name repeated within duplicate window"
          : payloadCheck.reason;
        if (duplicateEventName !== null) {
          if (isShortDuplicate) {
            console.debug(
              `[analyticsDuplicate] duplicate event=${duplicateEventName} deltaMs=${duplicateDeltaMs} windowMs=${duplicateWindowMs}`,
            );
          } else if (duplicateDeltaMs !== null) {
            console.debug(
              `[analyticsDuplicate] repeated outside window event=${duplicateEventName} deltaMs=${duplicateDeltaMs} treatedAsNormal=true`,
            );
          }
          liveDuplicateSeenByEventNameRef.current.set(duplicateEventName, {
            lastSeenAt: timestamp,
            lastResultType: matchType,
          });
        }
        logs.push({
          id: nextLiveLogId(),
          raw: rawLine,
          extracted: cleanedExtracted,
          normalizedEventName: normalizedCandidate.normalized,
          eventPath: null,
          value: null,
          timestamp,
          matchType,
          matchedRowId: null,
          reason,
          analyticsType: options.analyticsType ?? null,
          analyticsSource: options.analyticsSource ?? options.analyticsType ?? null,
        });
        const stats = computeStats(rows, logs);
        return { logs, rows, stats };
      }

      const m = matchPayload(cleanedExtracted, rows, idx);
      console.log(
        `[matcher] raw=${JSON.stringify(
          cleanedExtracted,
        )} normalized=${JSON.stringify(
          normalizedCandidate.normalized,
        )} matchedRowId=${m.matchedRowId ?? "null"}`,
      );
      let matchType = m.matchType;
      let reason = m.reason;

      if (duplicateEventName !== null) {
        if (isShortDuplicate) {
          matchType = "duplicate";
          reason = "Duplicate event name repeated within duplicate window";
          console.debug(
            `[analyticsDuplicate] duplicate event=${duplicateEventName} deltaMs=${duplicateDeltaMs} windowMs=${duplicateWindowMs}`,
          );
        } else if (duplicateDeltaMs !== null) {
          console.debug(
            `[analyticsDuplicate] repeated outside window event=${duplicateEventName} deltaMs=${duplicateDeltaMs} treatedAsNormal=true`,
          );
        }
        liveDuplicateSeenByEventNameRef.current.set(duplicateEventName, {
          lastSeenAt: timestamp,
          lastResultType: matchType,
        });
      }

      const entry: ParsedLogEntry = {
        id: nextLiveLogId(),
        raw: rawLine,
        extracted: cleanedExtracted,
        normalizedEventName: normalizedCandidate.normalized,
        eventPath: m.eventPath,
        value: m.value,
        timestamp,
        matchType,
        matchedRowId: m.matchedRowId,
        reason,
        analyticsType: options.analyticsType ?? null,
        analyticsSource: options.analyticsSource ?? options.analyticsType ?? null,
      };

      logs.push(entry);
      if (m.matchedRowId && options.analyticsType) {
        const matchedRow = rows.find((row) => row.id === m.matchedRowId);
        if (matchedRow) {
          matchedRow.cells.analyticsType = options.analyticsType;
          matchedRow.cells.analyticsSource =
            options.analyticsSource ?? options.analyticsType;
          matchedRow.meta = {
            ...(matchedRow.meta ?? {}),
            analyticsType: options.analyticsType,
            analyticsSource: options.analyticsSource ?? options.analyticsType,
          };
        }
      }
      if (entry.matchType !== "duplicate") {
        applyMatchToRows(rows, entry);
      }
      logCoverageDebugForPassedLog(entry, rows, logs);
      const stats = computeStats(rows, logs);
      return { logs, rows, stats };
    });
  }, [logCoverageDebugForPassedLog]);

  const handleUnityManualEventProcess = useCallback(() => {
    const lines = unityManualEventInput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      return;
    }
    if (!importResultRef.current?.rows.length) {
      setUnityLiveError(labels.noSpecLoaded);
      return;
    }

    setIsProcessingUnityManualEvent(true);
    try {
      setUnityLiveError(null);
      for (const line of lines) {
        const displayLine = toDisplayLiveLine(line);
        setUnityLiveFeedLines((prev) => {
          const id = nextLiveLogId();
          return [
            ...prev,
            {
              id,
              text: displayLine || line,
              rawLine: line,
              analyticsLine: line,
            },
          ].slice(-100);
        });
        setUnityLastLineAt(Date.now());
        setUnityAnalyticsEventsSeenCount((count) => count + 1);
        appendLiveAnalyticsLine(line);
      }
      setUnityManualEventInput("");
    } finally {
      setIsProcessingUnityManualEvent(false);
    }
  }, [appendLiveAnalyticsLine, labels.noSpecLoaded, unityManualEventInput]);

  const processIosLunarConsoleLines = useCallback(
    (lines: string[], source: "paste" | "file") => {
      if (!importResultRef.current?.rows.length) {
        setIosLiveError(labels.noSpecLoaded);
        return;
      }

      setIsProcessingIosLunarConsole(true);
      try {
        setIosLiveError(null);
        setIosLunarImportSource(source);

        for (const rawLine of lines) {
          const trimmed = rawLine.replace(/\r$/, "").trim();
          if (!trimmed) {
            continue;
          }

          setIosLunarRawLinesCount((count) => count + 1);
          setIosLunarLastRawLine(trimmed);
          setIosLunarRawPreviewLines((prev) =>
            [...prev, trimmed].slice(-100),
          );

          const parsed = parseIosLunarConsoleLogLine(rawLine);
          if (parsed === null) {
            continue;
          }

          setIosLunarAnalyticsCandidateLinesCount((count) => count + 1);
          setIosLunarLastExtractedEvent(parsed.extractedEvent);
          setIosLunarLastExtractedAnalyticsType(parsed.analyticsType);

          appendLiveAnalyticsLine(parsed.analyticsLine, {
            allowSingleSegmentPayload:
              parsed.analyticsType === "AppsFlyer" ||
              parsed.analyticsType === "AppMetrica",
            analyticsType: parsed.analyticsType,
            analyticsSource: parsed.analyticsType,
          });
        }
      } finally {
        setIsProcessingIosLunarConsole(false);
      }
    },
    [appendLiveAnalyticsLine, labels.noSpecLoaded],
  );

  const handleIosLunarConsoleProcess = useCallback(() => {
    const lines = iosLunarConsoleInput.split(/\r?\n/);
    if (lines.every((line) => line.trim() === "")) {
      return;
    }
    processIosLunarConsoleLines(lines, "paste");
    setIosLunarConsoleInput("");
  }, [iosLunarConsoleInput, processIosLunarConsoleLines]);

  const handleIosLunarConsoleFileSelect = useCallback(
    async (file: File) => {
      const text = await file.text();
      const lines = text.split(/\r?\n/);
      if (lines.every((line) => line.trim() === "")) {
        return;
      }
      processIosLunarConsoleLines(lines, "file");
    },
    [processIosLunarConsoleLines],
  );

  const handleAndroidConnect = useCallback(async () => {
    const packageNameOverride = androidPackageName.trim();
    if (!packageNameOverride) {
      setAndroidSpecRequiredError(null);
      setAndroidLiveError(labels.android.enterPackageFirst);
      setAndroidLiveStatus("error");
      return;
    }

    if (!importResultRef.current?.rows.length) {
      setAndroidSpecRequiredError(labels.android.uploadSpecFirst);
      return;
    }

    setAndroidSpecRequiredError(null);
    androidLiveContextRef.current += 1;
    const liveContext = androidLiveContextRef.current;
    setAndroidLiveError(null);
    setAndroidLiveStatus("connecting");
    setLiveFeedLines([]);
    setSelectedLiveFeedLineId(null);
    try {
      await clearAndroidBackendBuffer("android connect");
      if (androidLiveContextRef.current !== liveContext) {
        return;
      }

      const res = await fetch("/api/android/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageName: packageNameOverride }),
      });
      const data: { success?: boolean; error?: string } = await res.json();
      if (androidLiveContextRef.current !== liveContext) {
        return;
      }
      if (!data.success) {
        setAndroidLiveError(androidStartErrorMessage(data.error, labels));
        setAndroidLiveStatus("error");
        return;
      }

      eventSourceRef.current?.close();
      const es = new EventSource("/api/android/stream");
      eventSourceRef.current = es;

      es.onopen = () => {
        if (
          androidLiveContextRef.current !== liveContext ||
          eventSourceRef.current !== es
        ) {
          return;
        }
        setAndroidLiveStatus("live");
      };

      es.onmessage = (ev) => {
        if (
          androidLiveContextRef.current !== liveContext ||
          eventSourceRef.current !== es
        ) {
          return;
        }
        console.log("[live][sse] ev.data:", ev.data);
        console.log("[live][sse] typeof ev.data:", typeof ev.data);
        const line = ev.data ?? "";
        console.log("[live][sse] line before append:", line);
        if (!line) {
          return;
        }
        const displayLine = toDisplayLiveLine(line);
        setLiveFeedLines((prev) => {
          const id = nextLiveLogId();
          return [...prev, { id, text: displayLine || line.trim() }].slice(-100);
        });
        appendLiveAnalyticsLine(line);
      };

      es.onerror = () => {
        if (
          androidLiveContextRef.current !== liveContext ||
          eventSourceRef.current !== es
        ) {
          es.close();
          return;
        }
        setAndroidLiveError(labels.android.liveDisconnected);
        setAndroidLiveStatus("error");
        es.close();
        if (eventSourceRef.current === es) {
          eventSourceRef.current = null;
        }
      };
    } catch (e) {
      if (androidLiveContextRef.current !== liveContext) {
        return;
      }
      setAndroidLiveError(
        e instanceof Error ? e.message : labels.android.connectFailed,
      );
      setAndroidLiveStatus("error");
    }
  }, [androidPackageName, appendLiveAnalyticsLine, labels]);

  const handleIosConnect = useCallback(async () => {
    setIosLiveError(null);
    setIosLiveStatus("connecting");
    setIosLiveFeedLines([]);
    setSelectedLiveFeedLineId(null);
    iosEventSourceRef.current?.close();
    iosEventSourceRef.current = null;

    try {
      const res = await fetch("/api/ios/start", { method: "POST" });
      const data: { success?: boolean; error?: string } = await res.json();
      if (!data.success) {
        setIosLiveError(data.error ?? labels.ios.startFailed);
        setIosLiveStatus("error");
        return;
      }

      const es = new EventSource("/api/ios/stream");
      iosEventSourceRef.current = es;

      es.onopen = () => {
        setIosLiveStatus("live");
      };

      es.onmessage = (ev) => {
        const line = ev.data ?? "";
        if (!line) {
          return;
        }
        const displayLine = toDisplayLiveLine(line);
        setIosLiveFeedLines((prev) => {
          const id = nextLiveLogId();
          return [...prev, { id, text: displayLine || line.trim() }].slice(-100);
        });
        appendLiveAnalyticsLine(line);
      };

      es.onerror = () => {
        setIosLiveError(labels.ios.liveDisconnected);
        setIosLiveStatus("error");
        es.close();
        if (iosEventSourceRef.current === es) {
          iosEventSourceRef.current = null;
        }
      };
    } catch (e) {
      setIosLiveError(
        e instanceof Error ? e.message : labels.ios.connectFailed,
      );
      setIosLiveStatus("error");
    }
  }, [appendLiveAnalyticsLine, labels]);

  const handleIosStop = useCallback(async () => {
    await flushSheetSyncQueue();
    iosEventSourceRef.current?.close();
    iosEventSourceRef.current = null;
    setIosLiveFeedLines([]);
    try {
      await fetch("/api/ios/stop", { method: "POST" });
    } catch {
      /* ignore */
    }
    setIosLiveStatus("disconnected");
    setIosLiveError(null);
  }, [flushSheetSyncQueue]);

  const handleClearIosLive = useCallback(() => {
    setIosLiveFeedLines([]);
    setSelectedLiveFeedLineId(null);
    void fetch("/api/ios/clear", { method: "POST" }).catch((e) => {
      console.warn("[ios-live] failed to clear backend buffer", e);
    });
  }, []);

  const clearUnityConnectTimeout = useCallback(() => {
    if (unityConnectTimeoutRef.current !== null) {
      window.clearTimeout(unityConnectTimeoutRef.current);
      unityConnectTimeoutRef.current = null;
    }
  }, []);

  const applyUnityLiveDebug = useCallback((data: UnityLiveStartResponse) => {
    setUnityResolvedLogPath(
      data.resolvedLogPath?.trim() || data.logPath?.trim() || null,
    );
    setUnityLogFileName(data.logFileName?.trim() || null);
    setUnityLogSourceType(
      data.logSourceType === "editor" || data.logSourceType === "player"
        ? data.logSourceType
        : "custom",
    );
    setUnityDetectedProjectPath(data.detectedProjectPath?.trim() || null);
    setUnityDetectedProductName(data.detectedProductName?.trim() || null);
    setUnityLogFileExists(
      typeof data.logFileExists === "boolean" ? data.logFileExists : null,
    );
    setUnityWatcherStarted(Boolean(data.watcherStarted));
    setUnityLastError(data.lastError?.trim() || data.error?.trim() || null);
    setUnityLastLineAt(
      typeof data.lastLineAt === "number" ? data.lastLineAt : null,
    );
    setUnityAnalyticsEventsSeenCount(
      typeof data.analyticsEventsSeenCount === "number"
        ? data.analyticsEventsSeenCount
        : 0,
    );
    setUnityRawLinesSeenCount(
      typeof data.rawLinesSeenCount === "number" ? data.rawLinesSeenCount : 0,
    );
    setUnityAnalyticsCandidateLinesCount(
      typeof data.analyticsCandidateLinesCount === "number"
        ? data.analyticsCandidateLinesCount
        : typeof data.analyticsEventsSeenCount === "number"
          ? data.analyticsEventsSeenCount
          : 0,
    );
    setUnityLastRawLineAt(
      typeof data.lastRawLineAt === "number" ? data.lastRawLineAt : null,
    );
    setUnityInitialTailRead(data.initialTailRead === true);
    setUnityInitialTailLinesCount(
      typeof data.initialTailLinesCount === "number"
        ? data.initialTailLinesCount
        : 0,
    );
    setUnityLastRawLine(data.lastRawLine?.trim() || null);
    setUnityLastExtractedEvent(data.lastExtractedEvent?.trim() || null);
    setUnityLastExtractedAnalyticsType(
      data.lastExtractedAnalyticsType === "AppsFlyer" ||
        data.lastExtractedAnalyticsType === "AppMetrica" ||
        data.lastExtractedAnalyticsType === "ABTest"
        ? data.lastExtractedAnalyticsType
        : null,
    );
    setUnityTailMode(
      data.tailMode === "watcher" ||
        data.tailMode === "polling" ||
        data.tailMode === "both"
        ? data.tailMode
        : null,
    );
  }, []);

  const handleUnityConnect = useCallback(async () => {
    const requestId = unityConnectRequestSeqRef.current + 1;
    unityConnectRequestSeqRef.current = requestId;
    clearUnityConnectTimeout();
    setUnityLiveError(null);
    setUnityLastError(null);
    setUnityLiveStatus("connecting");
    setUnityLiveFeedLines([]);
    setSelectedUnityLiveFeedLineId(null);
    setUnityResolvedLogPath(null);
    setUnityLogFileName(null);
    setUnityLogSourceType("custom");
    setUnityDetectedProjectPath(null);
    setUnityDetectedProductName(null);
    setUnityLogFileExists(null);
    setUnityWatcherStarted(false);
    setUnityLastLineAt(null);
    setUnityAnalyticsEventsSeenCount(0);
    setUnityRawLinesSeenCount(0);
    setUnityAnalyticsCandidateLinesCount(0);
    setUnityLastRawLineAt(null);
    setUnityInitialTailRead(false);
    setUnityInitialTailLinesCount(0);
    setUnityLastRawLine(null);
    setUnityLastExtractedEvent(null);
    setUnityLastExtractedAnalyticsType(null);
    setUnityTailMode(null);
    unityEventSourceRef.current?.close();
    unityEventSourceRef.current = null;

    const controller = new AbortController();
    unityConnectTimeoutRef.current = window.setTimeout(() => {
      if (unityConnectRequestSeqRef.current !== requestId) {
        return;
      }
      console.warn("[unityLive] connectTimeout");
      controller.abort();
      setUnityWatcherStarted(false);
      setUnityLiveError(labels.unity.connectTimeout);
      setUnityLastError(labels.unity.connectTimeout);
      setUnityLiveStatus("error");
    }, unityLiveConnectTimeoutMs);

    try {
      const logPathOverride = unityLogPath.trim() || undefined;
      console.log(`[unityLive] connectStart path=${logPathOverride ?? "%LOCALAPPDATA%\\Unity\\Editor\\Editor.log"}`);
      const res = await fetch("/api/unity/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logPath: logPathOverride }),
        signal: controller.signal,
      });
      const data: UnityLiveStartResponse = await res.json();
      if (unityConnectRequestSeqRef.current !== requestId) {
        return;
      }
      clearUnityConnectTimeout();
      applyUnityLiveDebug(data);
      if (!data.success) {
        const error = localizeUnityLiveError(
          data.errorCode,
          data.error ?? data.lastError ?? labels.unity.startFailed,
          labels.unity,
        );
        setUnityLiveError(error);
        setUnityLastError(error);
        setUnityLiveStatus("error");
        return;
      }

      if (data.watcherStarted === false) {
        const error = data.lastError?.trim() || labels.unity.startFailed;
        setUnityLiveError(error);
        setUnityLastError(error);
        setUnityLiveStatus("error");
        return;
      }

      setUnityLastLineAt(null);
      setUnityAnalyticsEventsSeenCount(0);
      setUnityRawLinesSeenCount(0);
      setUnityAnalyticsCandidateLinesCount(0);
      setUnityLastRawLineAt(null);
      setUnityLastRawLine(null);
      setUnityLastExtractedEvent(null);
      setUnityLastExtractedAnalyticsType(null);

      setUnityLiveError(null);
      setUnityLastError(null);
      setUnityLiveStatus("live");
      const es = new EventSource("/api/unity/stream");
      unityEventSourceRef.current = es;

      es.onopen = () => {
        if (unityEventSourceRef.current !== es) {
          return;
        }
        setUnityLiveStatus("live");
        setUnityWatcherStarted(true);
      };

      es.onmessage = (ev) => {
        if (unityEventSourceRef.current !== es) {
          return;
        }
        const streamEntry = parseUnityLiveStreamEntry(ev.data ?? "");
        if (streamEntry === null) {
          return;
        }
        const now = Date.now();
        const analyticsLine = streamEntry.analyticsLine;
        const extractedFromAnalyticsLine =
          analyticsLine === null ? null : extractLiveAnalyticsPayload(analyticsLine);
        const extractedEvent =
          streamEntry.extractedEvent ??
          (extractedFromAnalyticsLine === null
            ? null
            : finalizeLivePayload(extractedFromAnalyticsLine));
        const analyticsType = streamEntry.analyticsType ?? null;
        setUnityLiveFeedLines((prev) => {
          const id = nextLiveLogId();
          return [
            ...prev,
            {
              id,
              text: streamEntry.rawLine,
              rawLine: streamEntry.rawLine,
              analyticsLine,
            },
          ].slice(-100);
        });
        setUnityRawLinesSeenCount((count) => count + 1);
        setUnityLastRawLineAt(now);
        setUnityLastLineAt(now);
        setUnityLastRawLine(streamEntry.rawLine);
        if (streamEntry.detectedProjectPath) {
          setUnityDetectedProjectPath(streamEntry.detectedProjectPath);
        }
        if (streamEntry.detectedProductName) {
          setUnityDetectedProductName(streamEntry.detectedProductName);
        }
        if (analyticsLine !== null) {
          setUnityAnalyticsEventsSeenCount((count) => count + 1);
          setUnityAnalyticsCandidateLinesCount((count) => count + 1);
          setUnityLastExtractedEvent(extractedEvent);
          setUnityLastExtractedAnalyticsType(analyticsType);
          appendLiveAnalyticsLine(analyticsLine, {
            allowSingleSegmentPayload:
              analyticsType === "AppsFlyer" || analyticsType === "AppMetrica",
            analyticsType,
            analyticsSource: analyticsType,
          });
        }
      };

      es.onerror = () => {
        if (unityEventSourceRef.current !== es) {
          es.close();
          return;
        }
        setUnityLiveError(labels.unity.liveDisconnected);
        setUnityLastError(labels.unity.liveDisconnected);
        setUnityLiveStatus("error");
        setUnityWatcherStarted(false);
        es.close();
        if (unityEventSourceRef.current === es) {
          unityEventSourceRef.current = null;
        }
      };
    } catch (e) {
      if (unityConnectRequestSeqRef.current !== requestId) {
        return;
      }
      clearUnityConnectTimeout();
      const message =
        e instanceof Error && e.name === "AbortError"
          ? labels.unity.connectTimeout
          : e instanceof Error
            ? e.message
            : labels.unity.connectFailed;
      setUnityLiveError(message);
      setUnityLastError(message);
      setUnityWatcherStarted(false);
      setUnityLiveStatus("error");
    }
  }, [
    appendLiveAnalyticsLine,
    applyUnityLiveDebug,
    clearUnityConnectTimeout,
    labels,
    unityLogPath,
  ]);

  const handleUnityStop = useCallback(async () => {
    await flushSheetSyncQueue();
    clearUnityConnectTimeout();
    unityConnectRequestSeqRef.current += 1;
    unityEventSourceRef.current?.close();
    unityEventSourceRef.current = null;
    try {
      await fetch("/api/unity/stop", { method: "POST" });
    } catch {
      /* ignore */
    }
    setUnityLiveStatus("disconnected");
    setUnityLiveError(null);
    setUnityWatcherStarted(false);
  }, [clearUnityConnectTimeout, flushSheetSyncQueue]);

  const handleClearUnityLive = useCallback(() => {
    setUnityLiveFeedLines([]);
    setSelectedUnityLiveFeedLineId(null);
    void fetch("/api/unity/clear", { method: "POST" }).catch((e) => {
      console.warn("[unity-live] failed to clear backend buffer", e);
    });
  }, []);

  const handleClearAndroidLiveLog = useCallback(() => {
    setLiveFeedLines([]);
    setSelectedLiveFeedLineId(null);
    void clearAndroidBackendBuffer("manual clear");
  }, []);

  const handleAndroidPackageNameChange = useCallback((value: string) => {
    const currentPackageName = androidPackageName.trim();
    const nextPackageName = value.trim();

    setAndroidPackageName(value);
    setAndroidPackageDetectError(null);

    if (nextPackageName === currentPackageName) {
      return;
    }

    clearSessionResults();
    setSelectedRowId(null);
    clearAndroidLiveContext("package change");
  }, [
    androidPackageName,
    clearAndroidLiveContext,
    clearSessionResults,
  ]);

  const handleDetectAndroidPackageName = useCallback(async () => {
    setAndroidPackageDetectError(null);
    setIsDetectingAndroidPackage(true);

    try {
      const res = await fetch("/api/android/detect", { method: "POST" });
      const data: {
        success?: boolean;
        packageName?: string;
        error?: string;
      } | null = await res.json().catch(() => null);
      const detectedPackageName = data?.packageName?.trim();
      const errorMessage = data?.error?.trim() || labels.android.detectFailed;

      if (!res.ok || data?.success === false || !detectedPackageName) {
        setAndroidPackageDetectError(errorMessage);
        return;
      }

      handleAndroidPackageNameChange(detectedPackageName);
    } catch (e) {
      console.warn("[android-package] failed to detect package name", e);
      setAndroidPackageDetectError(labels.android.detectFailed);
    } finally {
      setIsDetectingAndroidPackage(false);
    }
  }, [handleAndroidPackageNameChange, labels]);

  const handleSaveAndroidPackageName = useCallback(() => {
    const packageName = androidPackageName.trim();
    if (!packageName) {
      return;
    }

    setAndroidPackageName(packageName);
    setSavedAndroidPackageNames((prev) => {
      if (prev.includes(packageName)) {
        return prev;
      }

      const next = [...prev, packageName];
      try {
        window.localStorage.setItem(
          androidPackageNamesStorageKey,
          JSON.stringify(next),
        );
      } catch (e) {
        console.warn("[android-package] failed to save package name", e);
      }
      return next;
    });
  }, [androidPackageName]);

  const handleDeleteAndroidPackageName = useCallback(() => {
    const packageName = androidPackageName.trim();
    if (!packageName) {
      return;
    }

    setSavedAndroidPackageNames((prev) => {
      const next = prev.filter((saved) => saved !== packageName);
      if (next.length === prev.length) {
        return prev;
      }

      try {
        window.localStorage.setItem(
          androidPackageNamesStorageKey,
          JSON.stringify(next),
        );
      } catch (e) {
        console.warn("[android-package] failed to delete package name", e);
      }
      return next;
    });
  }, [androidPackageName]);

  const handleAndroidStop = useCallback(async () => {
    await flushSheetSyncQueue();
    androidLiveContextRef.current += 1;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setLiveFeedLines([]);
    setSelectedLiveFeedLineId(null);
    await stopAndroidBackend("manual stop");
    setAndroidLiveStatus("disconnected");
    setAndroidLiveError(null);
  }, [flushSheetSyncQueue]);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      if (sheetSyncTimerRef.current !== null) {
        window.clearTimeout(sheetSyncTimerRef.current);
        sheetSyncTimerRef.current = null;
      }
      if (googleSheetRowIndexRetryTimerRef.current !== null) {
        window.clearTimeout(googleSheetRowIndexRetryTimerRef.current);
        googleSheetRowIndexRetryTimerRef.current = null;
      }
      if (googleSheetTitleRetryTimerRef.current !== null) {
        window.clearTimeout(googleSheetTitleRetryTimerRef.current);
        googleSheetTitleRetryTimerRef.current = null;
      }
      if (googleSheetImportRetryTimerRef.current !== null) {
        window.clearTimeout(googleSheetImportRetryTimerRef.current);
        googleSheetImportRetryTimerRef.current = null;
      }
      iosEventSourceRef.current?.close();
      iosEventSourceRef.current = null;
      unityEventSourceRef.current?.close();
      unityEventSourceRef.current = null;
      void fetch("/api/android/stop", { method: "POST" });
      void fetch("/api/ios/stop", { method: "POST" });
      void fetch("/api/unity/stop", { method: "POST" });
    };
  }, []);

  const visibleUnityLiveFeedLines = useMemo(
    () =>
      unityLiveFeedLines
        .filter(
          (entry) => unityShowAllLogLines || entry.analyticsLine !== null,
        )
        .slice(-100)
        .map((entry) => {
          const text =
            unityShowAllLogLines || entry.analyticsLine === null
              ? entry.rawLine
              : toDisplayLiveLine(entry.analyticsLine) ||
                entry.analyticsLine;
          return { id: entry.id, text };
        }),
    [unityLiveFeedLines, unityShowAllLogLines],
  );

  const visibleLiveFeedLines =
    activePlatform === "unity"
      ? visibleUnityLiveFeedLines
      : activePlatform === "ios"
        ? iosLiveFeedLines
        : liveFeedLines;
  const visibleSelectedLiveFeedLineId =
    activePlatform === "unity"
      ? selectedUnityLiveFeedLineId
      : selectedLiveFeedLineId;

  useEffect(() => {
    const el = resolveLiveFeedScrollElement();
    if (!el) {
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [resolveLiveFeedScrollElement, visibleLiveFeedLines]);

  useEffect(() => {
    const el = resolveLiveFeedScrollElement();
    if (!el || visibleLiveFeedLines.length === 0) {
      return;
    }

    const items = Array.from(el.querySelectorAll("li"));
    const cleanups: Array<() => void> = [];

    for (let i = 0; i < items.length; i += 1) {
      const item = items[i] as HTMLElement;
      const live = visibleLiveFeedLines[i];
      if (!live) {
        continue;
      }

      item.style.cursor = "pointer";
      item.style.transition = "background-color 120ms ease";
      item.style.borderRadius = "8px";
      item.style.padding = "2px 4px";
      item.dataset.liveId = live.id;
      item.dataset.liveText = live.text;
      item.style.backgroundColor =
        live.id === visibleSelectedLiveFeedLineId
          ? "rgba(139, 92, 246, 0.2)"
          : "";

      const onMouseEnter = () => {
        if (item.dataset.liveId !== visibleSelectedLiveFeedLineId) {
          item.style.backgroundColor = "rgba(139, 92, 246, 0.12)";
        }
      };
      const onMouseLeave = () => {
        if (item.dataset.liveId !== visibleSelectedLiveFeedLineId) {
          item.style.backgroundColor = "";
        }
      };
      const onClick = () => {
        handleLiveFeedLineClick(live.id, live.text);
      };

      item.addEventListener("mouseenter", onMouseEnter);
      item.addEventListener("mouseleave", onMouseLeave);
      item.addEventListener("click", onClick);
      cleanups.push(() => {
        item.removeEventListener("mouseenter", onMouseEnter);
        item.removeEventListener("mouseleave", onMouseLeave);
        item.removeEventListener("click", onClick);
      });
    }

    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [
    handleLiveFeedLineClick,
    resolveLiveFeedScrollElement,
    visibleLiveFeedLines,
    visibleSelectedLiveFeedLineId,
  ]);

  useEffect(() => {
    if (!selectedRowId) {
      return;
    }
    const mainEl = document.querySelector("main");
    if (!mainEl) {
      return;
    }

    requestAnimationFrame(() => {
      const selected =
        (mainEl.querySelector("[aria-selected='true']") as HTMLElement | null) ??
        (mainEl.querySelector("[data-state='selected']") as HTMLElement | null);
      selected?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }, [selectedRowId]);

  const handleClearLogs = useCallback(() => {
    setLogText("");
  }, []);

  const handleResetSession = useCallback(() => {
    setMatchBundle(null);
    setProcessMessage(null);
    setUnknownLiveResults([]);
    unknownLiveResultsRef.current = [];
    unknownLiveLogIdsRef.current = new Set();
    liveDuplicateSeenByEventNameRef.current = new Map();
    clearGoogleSheetSyncErrorState();
    if (importResult?.rows.length) {
      setSelectedRowId(importResult.rows[0]?.id ?? null);
    } else {
      setSelectedRowId(null);
    }
  }, [clearGoogleSheetSyncErrorState, importResult]);

  const handleResetResults = useCallback(() => {
    setMatchBundle(null);
    setProcessMessage(null);
    setActiveSidebarFilter("all");
    setHighlightedMatchResultIds([]);
    setHighlightedTableRowIds([]);
    setRecentResultsScrollSignal(0);
    setTableScrollSignal(0);
    setUnknownLiveResults([]);
    unknownLiveResultsRef.current = [];
    unknownLiveLogIdsRef.current = new Set();
    knownMatchResultIdsRef.current = new Set();
    knownTableLogIdsRef.current = new Set();
    liveDuplicateSeenByEventNameRef.current = new Map();

    for (const timeout of highlightTimeoutsRef.current.values()) {
      window.clearTimeout(timeout);
    }
    highlightTimeoutsRef.current.clear();

    for (const timeout of tableHighlightTimeoutsRef.current.values()) {
      window.clearTimeout(timeout);
    }
    tableHighlightTimeoutsRef.current.clear();
    clearGoogleSheetSyncErrorState();

    setSelectedRowId((current) => {
      if (!importResult?.rows.length) {
        return null;
      }

      return importResult.rows.some((row) => row.id === current)
        ? current
        : importResult.rows[0]?.id ?? null;
    });
  }, [clearGoogleSheetSyncErrorState, importResult]);

  const statsBarCounts: StatsBarCounts | null = useMemo(() => {
    if (!importResult) {
      return {
        passedLogs: 0,
        duplicateLogs: 0,
        unknownLogs: 0,
        partialLogs: 0,
        notCheckedRows: 0,
      };
    }

    if (!matchBundle) {
      return {
        passedLogs: 0,
        duplicateLogs: 0,
        unknownLogs: 0,
        partialLogs: 0,
        notCheckedRows: importResult.rows.length,
      };
    }
    return {
      passedLogs: matchBundle.stats.rowStats.passed,
      duplicateLogs: matchBundle.stats.logStats.duplicateLogs,
      unknownLogs: matchBundle.stats.logStats.unknownLogs,
      partialLogs: matchBundle.stats.logStats.partialLogs,
      notCheckedRows: matchBundle.stats.rowStats.notChecked,
    };
  }, [importResult, matchBundle]);

  const activeFileName = (() => {
    if (!isImported) {
      return null;
    }
    if (
      googleSheetSourceUrl !== null &&
      googleSheetSyncMeta?.writebackSource !== "uploadedXlsx"
    ) {
      const debugGid =
        typeof importResult.debug.sourceGoogleSheetGid === "string"
          ? importResult.debug.sourceGoogleSheetGid
          : null;
      return googleSheetDisplayName(
        googleSheetSyncMeta?.sheetTitle,
        googleSheetSyncMeta?.gid ?? debugGid,
      );
    }
    return importResult.debug.fileName
      ? String(importResult.debug.fileName)
      : null;
  })();
  const isUploadedXlsxGoogleSyncAttached =
    googleSheetSourceUrl !== null &&
    googleSheetSyncMeta?.writebackSource === "uploadedXlsx";

  const matchResultsForPanel = useMemo(() => {
    if (matchBundle === null) return null;
    const statusFiltered = matchBundle.logs.filter((log) =>
      doesLogMatchSidebarFilter(log, activeSidebarFilter),
    );
    const eventGroupFiltered = platformUsesSdkEventGroupTabs(activePlatform)
      ? statusFiltered.filter((log) =>
          doesUnityLogMatchEventGroup(
            log,
            activeEventGroupTab,
            matchBundle.rows,
          ),
        )
      : statusFiltered;
    return sortLogsNewestFirst(eventGroupFiltered);
  }, [activeEventGroupTab, activePlatform, activeSidebarFilter, matchBundle]);

  const matchResultsEmptyMessage =
    activeSidebarFilter === "not_checked"
      ? labels.noNotCheckedEventResults
      : activeSidebarFilter === "all"
        ? labels.noEventsYet[activePlatform]
        : labels.noAnalyticsLinesInFilter(
            labels.filterLabels[activeSidebarFilter],
          );

  const processDisabled =
    !importResult?.rows.length || !logText.trim();

  const androidConnectDisabled =
    androidLiveStatus === "connecting" || androidLiveStatus === "live";

  const androidStopDisabled = androidLiveStatus === "disconnected";
  const iosConnectDisabled =
    iosLiveStatus === "connecting" || iosLiveStatus === "live";
  const iosStopDisabled = iosLiveStatus === "disconnected";
  const unityConnectDisabled =
    unityLiveStatus === "connecting" || unityLiveStatus === "live";
  const unityStopDisabled = unityLiveStatus === "disconnected";
  const unityManualEventProcessDisabled =
    !importResult?.rows.length ||
    unityManualEventInput.trim().length === 0 ||
    isProcessingUnityManualEvent;
  const trimmedAndroidPackageName = androidPackageName.trim();
  const savedAndroidPackageSelectValue = savedAndroidPackageNames.includes(
    trimmedAndroidPackageName,
  )
    ? trimmedAndroidPackageName
    : "";
  const saveAndroidPackageDisabled =
    !trimmedAndroidPackageName ||
    savedAndroidPackageNames.includes(trimmedAndroidPackageName);
  const deleteAndroidPackageDisabled =
    !trimmedAndroidPackageName ||
    !savedAndroidPackageNames.includes(trimmedAndroidPackageName);
  const androidDetectPackageDisabled = isDetectingAndroidPackage;

  const coverageSummaryData = useMemo(() => {
    if (!importResult?.rows.length || !specRowSource) return null;
    const rows = specRowSource;
    const total = rows.length;
    const knownRowIds = new Set(rows.map((r) => r.id));
    const passedRowIds = new Set(
      rows.filter((r) => r.status === "matched").map((r) => r.id),
    );
    const partialRowIds = new Set(
      rows.filter((r) => r.status === "partial").map((r) => r.id),
    );

    for (const log of matchBundle?.logs ?? []) {
      if (!log.matchedRowId || !knownRowIds.has(log.matchedRowId)) {
        continue;
      }
      if (log.matchType === "passed") {
        passedRowIds.add(log.matchedRowId);
        partialRowIds.delete(log.matchedRowId);
      } else if (
        log.matchType === "partial" &&
        !passedRowIds.has(log.matchedRowId)
      ) {
        partialRowIds.add(log.matchedRowId);
      }
    }

    const passedRows = passedRowIds.size;
    const partialRows = partialRowIds.size;
    const covered = passedRows + partialRows;
    const coveragePercent =
      total > 0 ? Math.round((covered / total) * 100) : 0;
    const notCheckedRows = Math.max(0, total - covered);
    return {
      covered,
      total,
      coveragePercent,
      passedRows,
      partialRows,
      notCheckedRows,
    };
  }, [importResult, matchBundle, specRowSource]);

  const showCoverageSummary = isImported && !isEmptyImport;
  const usedSheetNameForCheckedExport = importResult?.debug.usedSheetName;
  const checkColumnIndexForCheckedExport = importResult?.debug.checkColumnIndex;
  const isAnyImporting = isImporting || isImportingGoogleSheet;
  const isGoogleSheetSpecSource = googleSheetSourceUrl !== null;
  const canExportCheckedXlsx =
    !isGoogleSheetSpecSource &&
    !isAnyImporting &&
    originalWorkbookBufferRef.current !== null &&
    specRowSource !== null &&
    typeof usedSheetNameForCheckedExport === "string" &&
    usedSheetNameForCheckedExport.trim() !== "" &&
    typeof checkColumnIndexForCheckedExport === "number" &&
    Number.isInteger(checkColumnIndexForCheckedExport) &&
    checkColumnIndexForCheckedExport >= 0;

  const handleExportJson = useCallback(() => {
    if (!importResult) {
      return;
    }

    const now = new Date();
    const exportedAt = now.toISOString();

    const logs = matchBundle?.logs ?? [];
    const summaryLogs = {
      passed: logs.filter((l) => l.matchType === "passed").length,
      duplicate: logs.filter((l) => l.matchType === "duplicate").length,
      unknown: logs.filter((l) => l.matchType === "unknown").length,
      partial: logs.filter((l) => l.matchType === "partial").length,
      total: logs.length,
    };

    const rows = (specRowSource ?? []).map((r) => ({
      id: r.id,
      status: r.status,
      eventPath: String(r.cells.eventPath ?? r.hierarchy.join(".")),
      value: r.cells.value ?? null,
      description: r.cells.description ?? "",
    }));

    const exportObj = {
      version: 1,
      exportedAt,
      spec: {
        fileName: activeFileName,
        googleSheetUrl: googleSheetSourceUrl,
        warnings: importResult.warnings ?? [],
      },
      summary: {
        coverage: coverageSummaryData,
        logs: summaryLogs,
      },
      rows,
      logs: logs.map((l) => ({
        id: l.id,
        matchType: l.matchType,
        raw: l.raw,
        extracted: l.extracted ?? null,
        matchedRowId: l.matchedRowId ?? null,
        eventPath: l.eventPath ?? null,
        value: l.value ?? null,
        reason: l.reason ?? null,
        timestamp: l.timestamp,
      })),
    };

    const pad2 = (n: number) => String(n).padStart(2, "0");
    const ts =
      `${now.getFullYear()}-` +
      `${pad2(now.getMonth() + 1)}-` +
      `${pad2(now.getDate())}-` +
      `${pad2(now.getHours())}-` +
      `${pad2(now.getMinutes())}-` +
      `${pad2(now.getSeconds())}`;

    const safeSpec =
      activeFileName
        ? String(activeFileName)
            .replace(/\.[a-z0-9]+$/i, "")
            .replace(/[^a-z0-9-_]+/gi, "_")
            .slice(0, 40)
        : null;

    const fileName = safeSpec
      ? `analytics-checker-export-${safeSpec}-${ts}.json`
      : `analytics-checker-export-${ts}.json`;

    const blob = new Blob([JSON.stringify(exportObj, null, 2)], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [
    activeFileName,
    coverageSummaryData,
    googleSheetSourceUrl,
    importResult,
    matchBundle,
    specRowSource,
  ]);

  const handleExportCheckedXlsx = useCallback(async () => {
    const originalWorkbook = originalWorkbookBufferRef.current;
    const rows = specRowSource;
    const usedSheetName = importResult?.debug.usedSheetName;
    const checkColumnIndex = importResult?.debug.checkColumnIndex;

    if (!originalWorkbook || rows === null) {
      setProcessMessage(labels.exportMessages.importWorkbookFirst);
      return;
    }

    if (typeof usedSheetName !== "string" || usedSheetName.trim() === "") {
      setProcessMessage(labels.exportMessages.worksheetMetadataMissing);
      return;
    }

    if (
      typeof checkColumnIndex !== "number" ||
      !Number.isInteger(checkColumnIndex) ||
      checkColumnIndex < 0
    ) {
      setProcessMessage(labels.exportMessages.checkColumnMetadataMissing);
      return;
    }

    try {
      const checkedWorkbook = await exportCheckedWorkbook({
        originalWorkbook,
        rows,
        usedSheetName,
        checkColumnIndex,
      });
      const now = new Date();
      const pad2 = (n: number) => String(n).padStart(2, "0");
      const ts =
        `${now.getFullYear()}-` +
        `${pad2(now.getMonth() + 1)}-` +
        `${pad2(now.getDate())}-` +
        `${pad2(now.getHours())}-` +
        `${pad2(now.getMinutes())}-` +
        `${pad2(now.getSeconds())}`;
      const safeSpec =
        activeFileName
          ? String(activeFileName)
              .replace(/\.[a-z0-9]+$/i, "")
              .replace(/[^a-z0-9-_]+/gi, "_")
              .replace(/^_+|_+$/g, "")
              .slice(0, 40)
          : "";
      const fileName = `analytics-checker-checked-${safeSpec || "spec"}-${ts}.xlsx`;
      const blob = new Blob([checkedWorkbook], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setProcessMessage(null);
    } catch (e) {
      setProcessMessage(
        e instanceof Error
          ? labels.exportMessages.checkedXlsxFailedWithReason(e.message)
          : labels.exportMessages.checkedXlsxFailed,
      );
    }
  }, [activeFileName, importResult, labels, specRowSource]);

  const highlightedMatchResultIdSet = new Set(highlightedMatchResultIds);
  const isAndroidMode = activePlatform === "android";
  const isIosMode = activePlatform === "ios";
  const isUnityMode = activePlatform === "unity";
  const iosLunarConsoleProcessDisabled =
    !importResult?.rows.length ||
    iosLunarConsoleInput.trim().length === 0 ||
    isProcessingIosLunarConsole;
  const currentModeImportLabels = labels.modeImport[activePlatform];
  const currentModeGoogleLabels = {
    ...labels.google,
    sheetUrlHint: currentModeImportLabels.sheetUrlHint,
    sheetUrlHintPrefix:
      "sheetUrlHintPrefix" in currentModeImportLabels
        ? currentModeImportLabels.sheetUrlHintPrefix
        : undefined,
    sheetUrlHintStrongText:
      "sheetUrlHintStrongText" in currentModeImportLabels
        ? currentModeImportLabels.sheetUrlHintStrongText
        : undefined,
    sheetUrlHintSuffix:
      "sheetUrlHintSuffix" in currentModeImportLabels
        ? currentModeImportLabels.sheetUrlHintSuffix
        : undefined,
    writeSyncTitle: currentModeImportLabels.writeSyncTitle,
    sheetTabName: currentModeImportLabels.sheetTabNamePlaceholder,
  };
  const visibleGoogleRetrySeconds =
    nextGoogleRowIndexRetrySeconds ?? nextSheetSyncRetrySeconds;

  return (
    <div
      className={`theme-${theme} min-h-screen bg-[var(--bg-app)] p-6 text-[var(--text-main)] transition-colors`}
    >
      <div className="grid h-[calc(100vh-48px)] w-full min-w-0 grid-cols-[64px_240px_minmax(0,1fr)_320px] gap-4 [&>*]:min-h-0 [&>*]:h-full">
        <nav className="relative flex min-h-0 flex-col items-center rounded-2xl border border-[#2a2f3a] bg-[#171923] px-2 pb-7 pt-4 shadow-lg shadow-black/20">
          <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-2 overflow-y-auto">
            <p className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-[#6b7280]">
              {labels.mode}
            </p>
            {platformItems.map((item) => {
              const active = item.id === activePlatform;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={active}
                  aria-label={item.label}
                  title={item.label}
                  onClick={() => handleActivePlatformChange(item.id)}
                  className={[
                    sidebarIconButtonBase,
                    active ? sidebarIconButtonActive : sidebarIconButtonIdle,
                  ].join(" ")}
                >
                  {item.id === "android" ? (
                    <AndroidPlatformIcon />
                  ) : item.id === "ios" ? (
                    <ApplePlatformIcon />
                  ) : (
                    <UnityPlatformIcon />
                  )}
                </button>
              );
            })}
          </div>
          <div className="relative flex w-full shrink-0 justify-center pt-3">
            <button
              ref={settingsButtonRef}
              type="button"
              data-testid="settings-button"
              aria-pressed={settingsOpen}
              aria-label={labels.settings}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={handleSettingsButtonClick}
              className={[
                sidebarIconButtonBase,
                settingsOpen
                  ? sidebarIconButtonActive
                  : sidebarIconButtonIdle,
              ].join(" ")}
            >
              <SettingsIcon />
            </button>
          </div>
        </nav>
        <Sidebar
          onSpecFile={handleSpecFile}
          onGoogleSheetImport={handleGoogleSheetImport}
          onGoogleSheetImportCancel={handleGoogleSheetImportCancel}
          onGoogleSheetUrlChange={handleGoogleSheetUrlChange}
          onGoogleConnect={handleGoogleConnect}
          onGoogleReconnect={handleGoogleReconnect}
          onAutoUpdateGoogleSheetChange={handleAutoUpdateGoogleSheetChange}
          onRebuildGoogleRowIndex={handleRebuildGoogleRowIndex}
          onRetryGoogleSheetCheckboxDetection={
            handleRetryGoogleSheetCheckboxDetection
          }
          onManualCheckboxColumnChange={
            handleManualGoogleSheetCheckboxColumnChange
          }
          onManualSheetTitleChange={handleManualGoogleSheetTitleChange}
          onSaveManualSheetTitle={handleSaveManualGoogleSheetTitle}
          onUseManualCheckboxColumn={handleUseManualGoogleSheetCheckboxColumn}
          onTestGoogleSheetWrite={handleTestGoogleSheetWrite}
          onTestGoogleSheetExactG69={handleTestGoogleSheetExactG69}
          onTestGoogleSheetExactG85={handleTestGoogleSheetExactG85}
          onSyncPendingGoogleSheetNow={handleSyncPendingGoogleSheetNow}
          onExportCheckedXlsx={handleExportCheckedXlsx}
          onDetachSpec={handleDetachSpec}
          onClearLocalAppState={handleClearLocalAppState}
          isImporting={isImporting}
          isImportingGoogleSheet={isImportingGoogleSheet}
          isGoogleConnecting={isGoogleConnecting}
          isRetryingGoogleSheetCheckboxDetection={
            isRetryingGoogleSheetCheckboxDetection
          }
          isRebuildingGoogleRowIndex={isRebuildingGoogleRowIndex}
          googleAuthConfigured={googleAuthStatus.configured}
          googleAuthConnected={googleAuthStatus.connected}
          autoUpdateGoogleSheet={autoUpdateGoogleSheet}
          previewGoogleSheetWriteTargets={previewGoogleSheetWriteTargets}
          onPreviewGoogleSheetWriteTargetsChange={
            setPreviewGoogleSheetWriteTargets
          }
          autoUpdateGoogleSheetDisabledReason={
            autoUpdateGoogleSheetDisabledReason
          }
          autoUpdateGoogleSheetValidationMessage={
            autoUpdateGoogleSheetValidationMessage
          }
          googleSheetWriteTargetPreviewInfo={googleSheetWriteTargetPreview
            .slice(0, 5)
            .join("\n")}
          manualCheckboxColumn={manualCheckboxColumnInput}
          manualCheckboxColumnError={manualCheckboxColumnError}
          manualSheetTitle={manualSheetTitleInput}
          canUseManualCheckboxColumn={
            googleSheetSourceUrl !== null && googleSheetSyncMeta !== null
          }
          canEditManualSheetTitle={
            googleSheetSourceUrl !== null && googleSheetSyncMeta !== null
          }
          canTestGoogleSheetWrite={
            googleAuthStatus.connected &&
            googleSheetSourceUrl !== null &&
            getSelectedGoogleSheetCheckboxColumnIndex(
              googleSheetSyncMeta,
              manualCheckboxColumnInput,
            ) !== null &&
            getGoogleSheetWriteSheetTitle(googleSheetSyncMeta) !== null
          }
          canTestGoogleSheetExactG69={
            googleAuthStatus.connected &&
            googleSheetSourceUrl !== null &&
            googleSheetSyncMeta !== null &&
            getGoogleSheetWriteSheetTitle(googleSheetSyncMeta) !== null
          }
          canTestGoogleSheetExactG85={
            googleAuthStatus.connected &&
            googleSheetSourceUrl !== null &&
            googleSheetSyncMeta !== null &&
            getGoogleSheetWriteSheetTitle(googleSheetSyncMeta) !== null
          }
          canRebuildGoogleRowIndex={
            googleAuthStatus.connected &&
            googleSheetSourceUrl !== null &&
            googleSheetSyncMeta !== null &&
            getGoogleSheetWriteSheetTitle(googleSheetSyncMeta) !== null
          }
          canSyncPendingGoogleSheetNow={
            syncPendingNowDisabledReason === null
          }
          syncPendingNowDisabledReason={syncPendingNowDisabledReason}
          canExportCheckedXlsx={canExportCheckedXlsx}
          exportCheckedXlsxTitle={
            isGoogleSheetSpecSource
              ? labels.titles.xlsxExportForUploadedFiles
              : canExportCheckedXlsx
              ? labels.titles.downloadCheckedXlsx
              : labels.titles.importWorkbookForCheckedXlsx
          }
          exportCheckedXlsxHint={
            isGoogleSheetSpecSource
              ? labels.titles.xlsxExportForUploadedFiles
              : null
          }
          googleSheetDebugDetails={googleSheetDebugDetails}
          sheetSyncStatus={currentSheetSyncStatus}
          sheetSyncError={sheetSyncError}
          lastSheetSyncRowCount={
            lastGoogleSheetSyncStatus === "success"
              ? lastGoogleSheetSyncTotalUpdatedRows ??
                lastGoogleSheetSyncUpdatedRows.length
              : null
          }
          pendingSheetUpdateCount={pendingSheetUpdateCount}
          nextSheetSyncRetrySeconds={visibleGoogleRetrySeconds}
          importError={importError}
          googleSheetError={googleSheetError}
          googleSheetImportInfo={googleSheetImportInfo}
          googleSheetUrl={googleSheetUrl}
          importWarnings={importResult?.warnings ?? []}
          activeFileName={activeFileName}
          activeSourceUrl={googleSheetSourceUrl}
          isUploadedXlsxGoogleSyncAttached={
            isUploadedXlsxGoogleSyncAttached
          }
          labels={{
            import: labels.import,
            exportSectionTitle: labels.exportSectionTitle,
            detachSpec: labels.detachSpec,
            reading: labels.reading,
            uploadSpec: currentModeImportLabels.uploadSpec,
            fileImportFallback: labels.fileImportFallback,
            googleSheetUrlPlaceholder: labels.googleSheetUrlPlaceholder,
            googleSheetUrlHint: labels.googleSheetUrlHint,
            importGoogleSheet: labels.importGoogleSheet,
            importingGoogleSheet: labels.importingGoogleSheet,
            googleConnected: labels.googleConnected,
            googleNotConnected: labels.googleNotConnected,
            connectGoogle: labels.connectGoogle,
            connectingGoogle: labels.connectingGoogle,
            autoUpdateGoogleSheet: labels.autoUpdateGoogleSheet,
            checkboxColumn: labels.checkboxColumn,
            sheetTabName: labels.sheetTabName,
            useColumn: labels.useColumn,
            readOnlyMode: labels.readOnlyMode,
            sheetSync: labels.sheetSync,
            save: labels.buttons.save,
            debugDetails: labels.google.debugDetails,
            exportCheckedXlsx: labels.buttons.exportCheckedXlsx,
            google: currentModeGoogleLabels,
            loadedSpec: currentModeImportLabels.loadedSpec,
            loadedGoogleSheetSpec: labels.loadedSpec,
            fileUploadUnavailableForGoogleSheet:
              labels.fileUploadUnavailableForGoogleSheet,
            ready: labels.ready,
            warnings: labels.warnings,
            more: labels.more,
          }}
        />
        <main className="flex min-h-0 min-w-0 flex-col gap-4 overflow-hidden rounded-2xl border border-[#2a2f3a] bg-[#171923] p-5 shadow-lg shadow-black/20">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
              <StatsBar counts={statsBarCounts} labels={labels.stats} />
              <button
                type="button"
                onClick={handleResetResults}
                disabled={!importResult}
                className="ui-btn ui-btn-secondary shrink-0"
                title={
                  !importResult
                    ? labels.titles.importSpecToReset
                    : labels.titles.clearCounters
                }
              >
                {labels.buttons.resetResults}
              </button>
            </div>
          </div>
          {showCoverageSummary && coverageSummaryData ? (
            <CoverageSummary
              data={coverageSummaryData}
              labels={labels.coverage}
            />
          ) : null}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-hidden">
            <AnalyticsTable
              rows={tableRows}
              selectedRowId={selectedRowId}
              onSelectRow={setSelectedRowId}
              highlightedRowIds={highlightedTableRowIds}
              scrollToTopSignal={tableScrollSignal}
              eventGroupTabs={
                isImported ? (
                  <div className="flex min-w-0 flex-col gap-3">
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-[#9ca3af]">
                        {labels.eventTypeFilter}
                      </p>
                      <div className="flex min-w-0 flex-wrap gap-2">
                        {eventGroupTabsForCurrentPlatform.map((tab) => {
                          const active = tab.id === activeEventGroupTab;
                          return (
                            <button
                              key={tab.id}
                              type="button"
                              aria-pressed={active}
                              onClick={() => setActiveEventGroupTab(tab.id)}
                              className={[
                                "ui-btn ui-btn-sm",
                                active ? "ui-btn-active" : "ui-btn-tab",
                              ].join(" ")}
                            >
                              {tab.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <div
                      className="flex min-w-0 flex-col gap-1.5"
                      aria-label={labels.filters}
                    >
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-[#9ca3af]">
                        {labels.statusFilter}
                      </p>
                      <div className="flex min-w-0 flex-wrap gap-2">
                        {statusFilterTabs.map((item) => {
                          const active = item.id === activeSidebarFilter;
                          return (
                            <button
                              key={item.id}
                              type="button"
                              aria-pressed={active}
                              onClick={() => setActiveSidebarFilter(item.id)}
                              className={[
                                "ui-btn ui-btn-sm h-7 px-2.5 text-[11px]",
                                active ? "ui-btn-active" : "ui-btn-tab",
                              ].join(" ")}
                            >
                              {labels.filterLabels[item.id]}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                ) : null
              }
              isEmptyImport={isEmptyImport}
              isImported={isImported}
              labels={{
                ...labels.table,
                statuses: labels.statuses,
              }}
            />
            <div className="grid max-h-[260px] shrink-0 grid-cols-1 gap-3 overflow-hidden xl:h-[150px] xl:max-h-[18vh] xl:grid-cols-[minmax(0,1fr)_minmax(240px,320px)]">
              <div className="flex min-h-[120px] min-w-0 flex-col gap-1.5 overflow-hidden rounded-2xl border border-[#2a2f3a] bg-[#171923] p-2.5 shadow-lg shadow-black/20 xl:h-full xl:min-h-0">
                <h3 className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-[#9ca3af]">
                  {labels.recentResults}
                </h3>
                <ul
                  ref={recentResultsRef}
                  className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto overflow-x-hidden pr-1"
                >
                  {!isImported || isEmptyImport ? (
                    <li className="shrink-0 rounded-xl border border-[#2a2f3a] bg-[#1c1f2a]/50 p-2 text-xs text-[#9ca3af]">
                      {labels.noSpecLoaded}
                    </li>
                  ) : matchResultsForPanel === null ||
                    matchResultsForPanel.length === 0 ? (
                        <li className="shrink-0 rounded-xl border border-[#2a2f3a] bg-[#1c1f2a]/50 p-2 text-xs text-[#9ca3af]">
                          {matchResultsEmptyMessage}
                        </li>
                      ) : (
                        matchResultsForPanel.map((entry) => {
                          const highlighted = highlightedMatchResultIdSet.has(
                            entry.id,
                          );
                          const normalizedEventName =
                            entry.normalizedEventName?.trim() ?? "";
                          const showNormalizedEvent =
                            normalizedEventName.length > 0 &&
                            normalizedEventName !==
                              (entry.extracted ?? "").trim();
                          return (
                            <li
                              key={entry.id}
                              className={[
                                "shrink-0 rounded-xl border p-2 transition-colors duration-700",
                                highlighted
                                  ? "border-emerald-400/55 bg-emerald-500/[0.12] shadow-[0_0_0_1px_rgba(52,211,153,0.18)]"
                                  : "border-[var(--row-border)] bg-[#1c1f2a] hover:bg-[var(--row-hover-bg)]",
                              ].join(" ")}
                            >
                              <div className="flex min-w-0 items-start gap-2">
                                <StatusDot
                                  variant={matchTypeToDot(entry.matchType)}
                                  className="mt-1 shrink-0"
                                />
                                <div className="min-w-0 flex-1 space-y-1">
                                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                                    {highlighted ? (
                                      <span className="shrink-0 rounded border border-emerald-400/45 bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-200">
                                        {labels.new}
                                      </span>
                                    ) : null}
                                    <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-[#9ca3af]">
                                      {translateStatusLabel(entry.matchType, labels)}
                                    </span>
                                    {entry.eventPath ? (
                                      <span className="min-w-0 break-all font-mono text-[11px] text-violet-200/90">
                                        {entry.eventPath}
                                      </span>
                                    ) : null}
                                    {entry.analyticsType ? (
                                      <span className="shrink-0 rounded border border-sky-400/35 bg-sky-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-sky-200">
                                        {entry.analyticsType}
                                      </span>
                                    ) : null}
                                  </div>
                                  <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-[#d1d5db]">
                                    {entry.extracted ?? entry.raw.trim()}
                                  </pre>
                                  {showNormalizedEvent ? (
                                    <p className="break-all font-mono text-[10px] text-sky-200/85">
                                      normalized: {normalizedEventName}
                                    </p>
                                  ) : null}
                                  {entry.reason ? (
                                    <p className="text-[10px] text-[#9ca3af]">
                                      {entry.reason}
                                    </p>
                                  ) : null}
                                </div>
                              </div>
                            </li>
                          );
                        })
                      )}
                </ul>
              </div>

              <div className="min-h-[120px] min-w-0 overflow-y-auto rounded-xl border border-[#2a2f3a] bg-[#1c1f2a] p-2.5 xl:h-full xl:min-h-0">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[#9ca3af]">
                  {labels.selectedRowDetails}
                </h3>
                {selectedRowDetails ? (
                  <dl className="mt-1 space-y-0.5 text-[11px]">
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-[#9ca3af]">{labels.table.status}</dt>
                      <dd className="flex items-center gap-2 text-right text-[#e5e7eb]">
                        <StatusDot variant={selectedRowDetails.dotStatus} />
                        <span>
                          {translateStatusLabel(
                            selectedRowDetails.statusLabel,
                            labels,
                          )}
                        </span>
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="shrink-0 text-[#9ca3af]">
                        {labels.table.event}
                      </dt>
                      <dd className="max-w-[min(100%,36rem)] break-all text-right font-mono text-violet-200/95">
                        {selectedRowDetails.event}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="shrink-0 text-[#9ca3af]">
                        {labels.table.value}
                      </dt>
                      <dd className="max-w-[min(100%,36rem)] break-all text-right font-mono text-[#9ca3af]">
                        {selectedRowDetails.value ?? "-"}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="shrink-0 text-[#9ca3af]">
                        sourceRowNumber
                      </dt>
                      <dd className="text-right font-mono text-[#e5e7eb]">
                        {selectedRowDetails.sourceRowNumber ?? "-"}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="shrink-0 text-[#9ca3af]">
                        expectedRange
                      </dt>
                      <dd className="max-w-[min(100%,36rem)] break-all text-right font-mono text-sky-100">
                        {selectedRowDetails.expectedRange ?? "-"}
                      </dd>
                    </div>
                    <div className="pt-1 text-[#9ca3af]">
                      sourcePath:{" "}
                      <span className="font-mono text-[#d1d5db]">
                        {selectedRowDetails.sourcePathColumns.length > 0
                          ? selectedRowDetails.sourcePathColumns.join(" > ")
                          : "-"}
                      </span>
                    </div>
                    <div className="pt-1 text-[#9ca3af]">
                      rawRow:{" "}
                      <span className="font-mono text-[#d1d5db]">
                        {selectedRowDetails.rawRowPreview || "-"}
                      </span>
                    </div>
                    <div className="pt-1 text-[#9ca3af]">
                      {selectedRowDetails.description || "-"}
                    </div>
                  </dl>
                ) : (
                  <p className="mt-2 text-xs text-[#9ca3af]">
                    {labels.noRowSelected}
                  </p>
                )}
              </div>
            </div>
          </div>
        </main>
        <div className="flex min-h-0 flex-col gap-3">
          {isAndroidMode ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-1 text-xs font-medium text-[#aab2c0]">
                <label htmlFor="android-package-name">
                  {labels.android.packageName}
                </label>
                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                  <input
                    id="android-package-name"
                    type="text"
                    value={androidPackageName}
                    onChange={(e) =>
                      handleAndroidPackageNameChange(e.target.value)
                    }
                    placeholder="com.example.game"
                    className="h-9 min-w-0 rounded-lg border border-[#2a2f3a] bg-[#171923] px-3 text-sm text-[#f3f4f6] outline-none transition placeholder:text-[#5d6675] focus:border-[#4b5568]"
                  />
                  <button
                    type="button"
                    onClick={handleDetectAndroidPackageName}
                    disabled={androidDetectPackageDisabled}
                    className="ui-btn ui-btn-secondary"
                  >
                    {isDetectingAndroidPackage
                      ? labels.buttons.detecting
                      : labels.buttons.detectApp}
                  </button>
                </div>
              </div>
              {androidPackageDetectError ? (
                <p className="text-[11px] leading-snug text-red-300">
                  {androidPackageDetectError}
                </p>
              ) : null}
              <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2">
                <select
                  value={savedAndroidPackageSelectValue}
                  onChange={(e) =>
                    handleAndroidPackageNameChange(e.target.value)
                  }
                  className="h-9 min-w-0 rounded-lg border border-[#2a2f3a] bg-[#171923] px-2 text-xs text-[#f3f4f6] outline-none transition focus:border-[#4b5568]"
                >
                  <option value="" disabled>
                    {labels.android.savedPackages}
                  </option>
                  {savedAndroidPackageNames.map((packageName) => (
                    <option key={packageName} value={packageName}>
                      {packageName}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handleSaveAndroidPackageName}
                  disabled={saveAndroidPackageDisabled}
                  className="ui-btn ui-btn-secondary"
                >
                  {labels.buttons.save}
                </button>
                <button
                  type="button"
                  onClick={handleDeleteAndroidPackageName}
                  disabled={deleteAndroidPackageDisabled}
                  className="ui-btn ui-btn-danger"
                >
                  {labels.buttons.delete}
                </button>
              </div>
            </div>
          ) : isUnityMode ? null : (
            <div className="space-y-2 rounded-2xl border border-[#2a2f3a] bg-[#171923] p-3 shadow-lg shadow-black/20">
              <label className="flex flex-col gap-1 text-xs font-medium text-[#aab2c0]">
                {labels.ios.bundleId}
                <input
                  type="text"
                  value={iosBundleId}
                  onChange={(e) => setIosBundleId(e.target.value)}
                  placeholder="com.example.app"
                  className="h-9 rounded-lg border border-[#2a2f3a] bg-[#171923] px-3 text-sm text-[#f3f4f6] outline-none transition placeholder:text-[#5d6675] focus:border-[#4b5568]"
                />
              </label>
              <p className="text-[11px] leading-snug text-[#9ca3af]">
                {labels.ios.placeholder}
              </p>
            </div>
          )}
          <div className="min-h-0 flex-1">
            <LogPanel
              logText={logText}
              onLogTextChange={setLogText}
              onProcess={handleProcess}
              onClearLogs={handleClearLogs}
              onResetSession={handleResetSession}
              processDisabled={processDisabled}
              processMessage={processMessage}
              androidLiveStatus={
                isAndroidMode
                  ? androidLiveStatus
                  : isUnityMode
                    ? unityLiveStatus
                    : iosLiveStatus
              }
              androidLiveError={
                isAndroidMode
                  ? androidLiveError
                  : isUnityMode
                    ? unityLiveError
                    : iosLiveError
              }
              androidSpecRequiredError={
                isAndroidMode ? androidSpecRequiredError : null
              }
              liveFeedLines={visibleLiveFeedLines}
              onAndroidConnect={
                isAndroidMode
                  ? handleAndroidConnect
                  : isUnityMode
                    ? handleUnityConnect
                    : handleIosConnect
              }
              onAndroidStop={
                isAndroidMode
                  ? handleAndroidStop
                  : isUnityMode
                    ? handleUnityStop
                    : handleIosStop
              }
              onAndroidClearLive={
                isAndroidMode
                  ? handleClearAndroidLiveLog
                  : isUnityMode
                    ? handleClearUnityLive
                    : handleClearIosLive
              }
              androidConnectDisabled={
                isAndroidMode
                  ? androidConnectDisabled
                  : isUnityMode
                    ? unityConnectDisabled
                    : iosConnectDisabled
              }
              androidStopDisabled={
                isAndroidMode
                  ? androidStopDisabled
                  : isUnityMode
                    ? unityStopDisabled
                    : iosStopDisabled
              }
              liveTitle={
                isAndroidMode
                  ? labels.android.liveTitle
                  : isUnityMode
                    ? labels.unity.liveTitle
                    : labels.ios.liveTitle
              }
              liveStatusLabel={
                isUnityMode && unityLiveStatus === "live"
                  ? labels.unity.connectedStatus
                  : undefined
              }
              clearLiveLabel={labels.android.clearLive}
              connectLabel={
                isAndroidMode
                  ? labels.android.connect
                  : isUnityMode
                    ? labels.unity.connect
                    : labels.ios.connect
              }
              stopLabel={labels.android.stop}
              liveLogLabel={
                isAndroidMode
                  ? labels.android.liveLog
                  : isUnityMode
                    ? labels.unity.liveLog
                    : labels.ios.liveLog
              }
              liveEmptyMessage={
                isAndroidMode
                  ? labels.android.noLiveLines
                  : isUnityMode
                    ? unityLiveStatus === "live"
                      ? labels.unity.connectedNoEvents
                      : labels.unity.noLiveLines
                    : labels.ios.noLiveLines
              }
              livePlaceholderMessage={null}
              liveClearDisabled={false}
              livePathLabel={
                isUnityMode ? labels.unity.logPath : undefined
              }
              livePathValue={isUnityMode ? unityLogPath : undefined}
              onLivePathChange={
                isUnityMode ? setUnityLogPath : undefined
              }
              livePathPlaceholder={
                isUnityMode
                  ? "C:\\Users\\user\\AppData\\Local\\Unity\\Editor\\Editor.log"
                  : undefined
              }
              livePathHint={
                isUnityMode
                  ? `${labels.unity.logPathHint} ${labels.unity.logTargetHint}`
                  : undefined
              }
              liveShowAllLinesLabel={
                isUnityMode ? labels.unity.showAllLogLines : undefined
              }
              liveShowAllLinesChecked={
                isUnityMode ? unityShowAllLogLines : undefined
              }
              onLiveShowAllLinesChange={
                isUnityMode ? setUnityShowAllLogLines : undefined
              }
              manualEventLabel={
                isUnityMode ? labels.unity.eventInputLabel : undefined
              }
              manualEventValue={
                isUnityMode ? unityManualEventInput : undefined
              }
              manualEventPlaceholder={
                isUnityMode ? labels.unity.eventInputPlaceholder : undefined
              }
              manualEventProcessLabel={
                isUnityMode ? labels.unity.processEvent : undefined
              }
              manualEventProcessDisabled={
                isUnityMode ? unityManualEventProcessDisabled : undefined
              }
              onManualEventChange={
                isUnityMode ? setUnityManualEventInput : undefined
              }
              onManualEventProcess={
                isUnityMode ? handleUnityManualEventProcess : undefined
              }
              lunarConsoleTitle={
                isIosMode ? labels.ios.lunarConsoleTitle : undefined
              }
              lunarConsoleValue={
                isIosMode ? iosLunarConsoleInput : undefined
              }
              lunarConsolePlaceholder={
                isIosMode ? labels.ios.lunarConsolePlaceholder : undefined
              }
              lunarConsoleProcessLabel={
                isIosMode ? labels.ios.lunarConsoleProcess : undefined
              }
              lunarConsoleProcessDisabled={
                isIosMode ? iosLunarConsoleProcessDisabled : undefined
              }
              onLunarConsoleChange={
                isIosMode ? setIosLunarConsoleInput : undefined
              }
              onLunarConsoleProcess={
                isIosMode ? handleIosLunarConsoleProcess : undefined
              }
              lunarConsoleUploadLabel={
                isIosMode ? labels.ios.lunarConsoleUpload : undefined
              }
              lunarConsoleUploadHint={
                isIosMode ? labels.ios.lunarConsoleUploadHint : undefined
              }
              onLunarConsoleFileSelect={
                isIosMode ? handleIosLunarConsoleFileSelect : undefined
              }
              lunarConsoleRawPreviewLabel={
                isIosMode ? labels.ios.lunarConsoleRawPreview : undefined
              }
              lunarConsoleRawPreviewLines={
                isIosMode ? iosLunarRawPreviewLines : undefined
              }
              labels={{
                ...labels.logPanel,
                statuses: {
                  disconnected: labels.statuses.disconnected,
                  connecting: labels.statuses.connecting,
                  live: labels.statuses.live,
                  error: labels.statuses.error,
                },
              }}
            />
          </div>
        </div>
      </div>
      {settingsOpen ? (
        <div
          ref={settingsPopoverRef}
          data-testid="settings-popover"
          role="dialog"
          aria-label={labels.settings}
          onPointerDown={(event) => event.stopPropagation()}
          style={{
            left:
              settingsPopoverPosition?.left ??
              64 + settingsPopoverOffsetPx,
            top:
              settingsPopoverPosition?.top ??
              settingsPopoverViewportPaddingPx,
            backgroundColor:
              theme === "dark"
                ? "rgba(10, 18, 42, 0.98)"
                : "rgba(255, 255, 255, 0.66)",
            borderColor:
              theme === "dark"
                ? "rgba(152, 178, 255, 0.32)"
                : "rgba(148, 163, 184, 0.36)",
            boxShadow:
              theme === "dark"
                ? "0 24px 70px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.04)"
                : "0 24px 70px rgba(15,23,42,0.12), inset 0 1px 0 rgba(255,255,255,0.62)",
          }}
          className="fixed z-[9999] min-h-[120px] w-[220px] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-2xl border p-3 backdrop-blur-xl"
        >
          <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-[#9ca3af]">
            {labels.settings}
          </h2>
          <div className="space-y-2">
            <div className={pillToggleBase}>
              {(["en", "ru"] as const).map((language) => {
                const active = language === uiLanguage;
                const label =
                  language === "en"
                    ? "English language"
                    : "Russian language";
                return (
                  <button
                    key={language}
                    type="button"
                    aria-pressed={active}
                    aria-label={label}
                    title={label}
                    onClick={() => setUiLanguage(language)}
                    className={`${pillSegmentBase} ${
                      active ? pillSegmentActive : pillSegmentIdle
                    }`}
                  >
                    {language.toUpperCase()}
                  </button>
                );
              })}
            </div>
            <div className={pillToggleBase}>
              {(["light", "dark"] as const).map((item) => {
                const active = item === theme;
                const label = item === "light" ? "Light theme" : "Dark theme";
                return (
                  <button
                    key={item}
                    type="button"
                    aria-pressed={active}
                    aria-label={label}
                    title={label}
                    onClick={() => setTheme(item)}
                    className={`${pillSegmentBase} ${
                      active ? pillSegmentActive : pillSegmentIdle
                    }`}
                  >
                    {item === "light" ? <SunThemeIcon /> : <MoonThemeIcon />}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
