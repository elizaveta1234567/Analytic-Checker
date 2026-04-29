"use client";

import {
  applyMatchToRows,
  buildMatcherIndexes,
  computeStats,
  extractAnalyticsPayload,
  importSpec,
  matchLogLinesAgainstSpec,
  matchPayload,
  normalizeValue,
  validateExtractedPayload,
  type MatcherStats,
  type ParsedLogEntry,
  type ParsedSpecResult,
} from "@/lib/analytics";
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
import {
  MOCK_RECENT_LOG_ITEMS,
  MOCK_SELECTED_ROW_ID,
  MOCK_TABLE_ROWS,
} from "@/components/analytics/mock-ui";
import type { SidebarFilter } from "@/components/analytics/Sidebar";
import {
  mockToTableRowModel,
  specToTableRowModel,
} from "@/components/analytics/specRowDisplay";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type AndroidLiveStatus =
  | "disconnected"
  | "connecting"
  | "live"
  | "error";

type PlatformMode = "android" | "ios";

type EventGroupTabId =
  | "all"
  | "subscription"
  | "tracking_confirmed"
  | "inapp"
  | "tracking_purchase"
  | "funnel";

const defaultAndroidPackageName = "mother.simulator.baby.care.games";
const androidPackageNamesStorageKey = "analytics-checker.androidPackageNames";
const liveHardDuplicateWindowMs = 250;

const platformItems: Array<{ id: PlatformMode; label: string }> = [
  { id: "android", label: "Android" },
  { id: "ios", label: "iOS" },
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

const eventGroupTabs: Array<{ id: EventGroupTabId; label: string }> = [
  { id: "all", label: "All events" },
  { id: "subscription", label: "Subscription" },
  { id: "tracking_confirmed", label: "Tracking confirmed" },
  { id: "inapp", label: "Inapp" },
  { id: "tracking_purchase", label: "Tracking purchase" },
  { id: "funnel", label: "Funnel" },
];

const eventGroupPathByTab: Record<
  Exclude<EventGroupTabId, "all">,
  string
> = {
  subscription: "subscription",
  tracking_confirmed: "tracking.confirmed",
  inapp: "inapp",
  tracking_purchase: "tracking.purchase",
  funnel: "funnel",
};

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

function doesRowMatchEventGroup(
  row: AnalyticsSpecRow,
  activeGroup: EventGroupTabId,
): boolean {
  if (activeGroup === "all") {
    return true;
  }

  return eventPathMatchesGroup(
    specRowEventPath(row),
    eventGroupPathByTab[activeGroup],
  );
}

function liveDuplicateFingerprint(
  eventPath: string | null,
  value: string | null,
  extracted: string | null,
): string | null {
  if (!eventPath || !extracted) {
    return null;
  }

  return [
    normalizeValue(eventPath),
    normalizeValue(value),
    normalizeValue(extracted),
  ].join("\0");
}

function liveDuplicateSignal(
  eventPath: string | null,
  value: string | null,
  extracted: string,
): string {
  return [eventPath ?? "", value ?? "", extracted]
    .map((part) => normalizeValue(part).replace(/[^a-z0-9]+/g, " "))
    .join(" ")
    .trim();
}

function signalHasAny(signal: string, terms: string[]): boolean {
  const tokens = new Set(signal.split(/\s+/).filter(Boolean));
  return terms.some((term) =>
    term.includes(" ") ? signal.includes(term) : tokens.has(term),
  );
}

function isLiveHardDuplicateCandidate(
  eventPath: string | null,
  value: string | null,
  extracted: string,
): boolean {
  const signal = liveDuplicateSignal(eventPath, value, extracted);
  const excludedTokens = [
    "open",
    "opened",
    "claim",
    "purchase attempt",
    "purchaseattempt",
    "impression",
    "view",
    "show",
    "screen",
    "ad",
    "ads",
    "service",
    "internal",
    "sdk",
    "adservice",
  ];

  if (signalHasAny(signal, excludedTokens)) {
    return false;
  }

  return signalHasAny(signal, [
    "click",
    "tap",
    "tapped",
    "clicked",
    "button",
    "press",
    "confirm",
    "submit",
    "accept",
  ]);
}

function buildTableRows(
  result: ParsedSpecResult | null,
  specSource: AnalyticsSpecRow[] | null,
) {
  if (result === null) {
    return MOCK_TABLE_ROWS.map(mockToTableRowModel);
  }
  const source = specSource ?? result.rows;
  return source.map(specToTableRowModel);
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

function translateStatusLabel(label: string): string {
  switch (label.toLowerCase()) {
    case "passed":
    case "matched":
      return "Passed";
    case "partial":
      return "Partial";
    case "duplicate":
      return "Duplicate";
    case "unknown":
      return "Unknown";
    case "not checked":
    case "not_checked":
      return "Not checked";
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

function androidStartErrorMessage(error: string | undefined): string {
  const message = error?.trim();
  if (!message) {
    return "Android connect failed";
  }

  if (isAndroidDeviceConnectionError(message)) {
    return "No Android device connected. Connect a device and allow USB debugging.";
  }

  if (isAndroidPackageContextError(message)) {
    return "The uploaded spec does not match the current package name.";
  }

  return message;
}

export default function Home() {
  const [importResult, setImportResult] = useState<ParsedSpecResult | null>(
    null,
  );
  const [selectedRowId, setSelectedRowId] = useState<string | null>(
    MOCK_SELECTED_ROW_ID,
  );
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [logText, setLogText] = useState("");
  const [matchBundle, setMatchBundle] = useState<{
    logs: ParsedLogEntry[];
    rows: AnalyticsSpecRow[];
    stats: MatcherStats;
  } | null>(null);
  const [processMessage, setProcessMessage] = useState<string | null>(null);
  const [activeSidebarFilter, setActiveSidebarFilter] =
    useState<SidebarFilter>("all");
  const [activeEventGroupTab, setActiveEventGroupTab] =
    useState<EventGroupTabId>("all");
  const [activePlatform, setActivePlatform] =
    useState<PlatformMode>("android");
  const [androidPackageName, setAndroidPackageName] = useState(
    defaultAndroidPackageName,
  );
  const [iosBundleId, setIosBundleId] = useState("");
  const [savedAndroidPackageNames, setSavedAndroidPackageNames] = useState<
    string[]
  >([defaultAndroidPackageName]);
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

  const eventSourceRef = useRef<EventSource | null>(null);
  const iosEventSourceRef = useRef<EventSource | null>(null);
  const liveFeedScrollRef = useRef<HTMLElement | null>(null);
  const recentResultsRef = useRef<HTMLUListElement | null>(null);
  const importResultRef = useRef(importResult);
  const androidLiveContextRef = useRef(0);
  const knownMatchResultIdsRef = useRef<Set<string>>(new Set());
  const highlightTimeoutsRef = useRef<Map<string, number>>(new Map());
  const knownTableLogIdsRef = useRef<Set<string>>(new Set());
  const tableHighlightTimeoutsRef = useRef<Map<string, number>>(new Map());
  importResultRef.current = importResult;

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(androidPackageNamesStorageKey);
      if (!raw) {
        window.localStorage.setItem(
          androidPackageNamesStorageKey,
          JSON.stringify([defaultAndroidPackageName]),
        );
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
        setSavedAndroidPackageNames([defaultAndroidPackageName]);
        window.localStorage.setItem(
          androidPackageNamesStorageKey,
          JSON.stringify([defaultAndroidPackageName]),
        );
        return;
      }

      setSavedAndroidPackageNames(packageNames);
      setAndroidPackageName(packageNames[0]);
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
    setSelectedLiveFeedLineId(clickedId);
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
  }, [matchBundle]);

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
          .filter((log) =>
            doesLogUpdateVisibleTableRow(log, activeSidebarFilter),
          )
          .map((log) => log.matchedRowId as string),
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
        doesRowMatchEventGroup(row, activeEventGroupTab),
      );
    }, [activeEventGroupTab, filteredTableRowSource]);

  const tableRows = useMemo(
    () => buildTableRows(importResult, eventGroupFilteredTableRowSource),
    [eventGroupFilteredTableRowSource, importResult],
  );

  const isImported = importResult !== null;
  const isEmptyImport = isImported && importResult.rows.length === 0;

  const selectedRowDetails = useMemo(() => {
    if (importResult === null) {
      const row = MOCK_TABLE_ROWS.find((r) => r.id === selectedRowId);
      if (!row) return null;
      const m = mockToTableRowModel(row);
      return {
        event: m.event,
        statusLabel: m.statusLabel,
        value: m.value,
        description: m.description,
        dotStatus: m.dotStatus,
      };
    }
    if (importResult.rows.length === 0) return null;
    const row = specRowSource?.find((r) => r.id === selectedRowId);
    if (!row) return null;
    const m = specToTableRowModel(row);
    return {
      event: m.event,
      statusLabel: m.statusLabel,
      value: m.value,
      description: m.description,
      dotStatus: m.dotStatus,
    };
  }, [importResult, selectedRowId, specRowSource]);

  const clearSessionResults = useCallback(() => {
    setMatchBundle(null);
    setProcessMessage(null);
    setActiveSidebarFilter("all");
    setHighlightedMatchResultIds([]);
    setHighlightedTableRowIds([]);
    setRecentResultsScrollSignal(0);
    setTableScrollSignal(0);
    knownMatchResultIdsRef.current = new Set();
    knownTableLogIdsRef.current = new Set();

    for (const timeout of highlightTimeoutsRef.current.values()) {
      window.clearTimeout(timeout);
    }
    highlightTimeoutsRef.current.clear();

    for (const timeout of tableHighlightTimeoutsRef.current.values()) {
      window.clearTimeout(timeout);
    }
    tableHighlightTimeoutsRef.current.clear();
  }, []);

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

  const handleSpecFile = useCallback(async (file: File) => {
    setIsImporting(true);
    setImportError(null);
    try {
      const res = await importSpec(file);
      setImportResult(res);
      setAndroidSpecRequiredError(null);
      clearSessionResults();
      setSelectedRowId(null);
      clearAndroidLiveContext("spec change");
    } catch (e) {
      setImportError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setIsImporting(false);
    }
  }, [clearAndroidLiveContext, clearSessionResults]);

  const handleProcess = useCallback(() => {
    if (!importResult?.rows.length || !logText.trim()) {
      return;
    }
    setMatchBundle((prev) => {
      const baseRows = prev?.rows ?? importResult.rows;
      const batch = matchLogLinesAgainstSpec(logText, baseRows);
      const logs = [...(prev?.logs ?? []), ...batch.logs];
      const stats = computeStats(batch.rows, logs);
      return { logs, rows: batch.rows, stats };
    });
    setProcessMessage(null);
  }, [importResult, logText]);

  const appendLiveAnalyticsLine = useCallback((rawLine: string) => {
    console.log("[live][append] rawLine:", rawLine);
    const spec = importResultRef.current;
    if (!spec?.rows.length) {
      return;
    }
    setMatchBundle((prev) => {
      const trimmed = rawLine.trim();
      if (!trimmed) {
        return prev;
      }

      let rows: AnalyticsSpecRow[];
      let logs: ParsedLogEntry[];

      if (prev === null) {
        const empty = matchLogLinesAgainstSpec("", spec.rows);
        rows = empty.rows;
        logs = [...empty.logs];
      } else {
        rows = prev.rows;
        logs = [...prev.logs];
      }

      const extracted = extractAnalyticsPayload(rawLine);
      const cleanedExtracted =
        extracted === null ? null : finalizeLivePayload(extracted);
      console.log("[live][append] extracted payload:", cleanedExtracted);
      if (cleanedExtracted === null) {
        console.log("LIVE_MATCH_SKIP: payload is null");
        return prev;
      }

      const idx = buildMatcherIndexes(rows);
      const payloadCheck = validateExtractedPayload(cleanedExtracted);
      if (!payloadCheck.valid) {
        logs.push({
          id: nextLiveLogId(),
          raw: rawLine,
          extracted: cleanedExtracted,
          eventPath: null,
          value: null,
          timestamp: Date.now(),
          matchType: "unknown",
          matchedRowId: null,
          reason: payloadCheck.reason,
        });
        const stats = computeStats(rows, logs);
        return { logs, rows, stats };
      }

      const m = matchPayload(cleanedExtracted, rows, idx);
      let matchType = m.matchType;
      let reason = m.reason;
      const timestamp = Date.now();

      if (matchType === "passed" && m.matchedRowId) {
        const fingerprint = liveDuplicateFingerprint(
          m.eventPath,
          m.value,
          cleanedExtracted,
        );
        const previous = logs[logs.length - 1];

        if (
          fingerprint &&
          previous &&
          (previous.matchType === "passed" ||
            previous.matchType === "duplicate")
        ) {
          const previousFingerprint = liveDuplicateFingerprint(
            previous.eventPath,
            previous.value,
            previous.extracted,
          );
          const isImmediateRepeat = fingerprint === previousFingerprint;
          const isDuplicateCandidate = isLiveHardDuplicateCandidate(
            m.eventPath,
            m.value,
            cleanedExtracted,
          );

          if (isImmediateRepeat && isDuplicateCandidate) {
            const deltaMs = timestamp - previous.timestamp;
            if (deltaMs >= 0 && deltaMs < liveHardDuplicateWindowMs) {
              matchType = "duplicate";
              reason =
                `Duplicate within ${deltaMs} ms (same event fingerprint)`;
            }
          }
        }
      }

      const entry: ParsedLogEntry = {
        id: nextLiveLogId(),
        raw: rawLine,
        extracted: cleanedExtracted,
        eventPath: m.eventPath,
        value: m.value,
        timestamp,
        matchType,
        matchedRowId: m.matchedRowId,
        reason,
      };

      logs.push(entry);
      applyMatchToRows(rows, entry);
      const stats = computeStats(rows, logs);
      return { logs, rows, stats };
    });
  }, []);

  const handleAndroidConnect = useCallback(async () => {
    if (!importResultRef.current?.rows.length) {
      setAndroidSpecRequiredError("Please upload a spec first.");
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

      const packageNameOverride = androidPackageName.trim() || undefined;
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
        setAndroidLiveError(androidStartErrorMessage(data.error));
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
        setAndroidLiveError("Live stream disconnected");
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
        e instanceof Error ? e.message : "Android connect failed",
      );
      setAndroidLiveStatus("error");
    }
  }, [androidPackageName, appendLiveAnalyticsLine]);

  const handleIosConnect = useCallback(async () => {
    setIosLiveError(null);
    setIosLiveStatus("connecting");
    try {
      const res = await fetch("/api/ios/start", { method: "POST" });
      const data: { success?: boolean; error?: string } = await res.json();
      if (!data.success) {
        setIosLiveError(data.error ?? "iOS start failed");
        setIosLiveStatus("error");
        return;
      }

      iosEventSourceRef.current?.close();
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
        setIosLiveError("Live stream disconnected");
        setIosLiveStatus("error");
        es.close();
        if (iosEventSourceRef.current === es) {
          iosEventSourceRef.current = null;
        }
      };
    } catch (e) {
      setIosLiveError(
        e instanceof Error ? e.message : "iOS connect failed",
      );
      setIosLiveStatus("error");
    }
  }, [appendLiveAnalyticsLine]);

  const handleIosStop = useCallback(async () => {
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
    androidLiveContextRef.current += 1;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setLiveFeedLines([]);
    setSelectedLiveFeedLineId(null);
    await stopAndroidBackend("manual stop");
    setAndroidLiveStatus("disconnected");
    setAndroidLiveError(null);
  }, []);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      iosEventSourceRef.current?.close();
      iosEventSourceRef.current = null;
      void fetch("/api/android/stop", { method: "POST" });
      void fetch("/api/ios/stop", { method: "POST" });
    };
  }, []);

  useEffect(() => {
    const el = resolveLiveFeedScrollElement();
    if (!el) {
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [liveFeedLines, resolveLiveFeedScrollElement]);

  useEffect(() => {
    const el = resolveLiveFeedScrollElement();
    if (!el || liveFeedLines.length === 0) {
      return;
    }

    const items = Array.from(el.querySelectorAll("li"));
    const cleanups: Array<() => void> = [];

    for (let i = 0; i < items.length; i += 1) {
      const item = items[i] as HTMLElement;
      const live = liveFeedLines[i];
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
        live.id === selectedLiveFeedLineId ? "rgba(139, 92, 246, 0.2)" : "";

      const onMouseEnter = () => {
        if (item.dataset.liveId !== selectedLiveFeedLineId) {
          item.style.backgroundColor = "rgba(139, 92, 246, 0.12)";
        }
      };
      const onMouseLeave = () => {
        if (item.dataset.liveId !== selectedLiveFeedLineId) {
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
    liveFeedLines,
    resolveLiveFeedScrollElement,
    selectedLiveFeedLineId,
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
    if (importResult?.rows.length) {
      setSelectedRowId(importResult.rows[0]?.id ?? null);
    } else {
      setSelectedRowId(MOCK_SELECTED_ROW_ID);
    }
  }, [importResult]);

  const handleResetResults = useCallback(() => {
    setMatchBundle(null);
    setProcessMessage(null);
    setActiveSidebarFilter("all");
    setHighlightedMatchResultIds([]);
    setHighlightedTableRowIds([]);
    setRecentResultsScrollSignal(0);
    setTableScrollSignal(0);
    knownMatchResultIdsRef.current = new Set();
    knownTableLogIdsRef.current = new Set();

    for (const timeout of highlightTimeoutsRef.current.values()) {
      window.clearTimeout(timeout);
    }
    highlightTimeoutsRef.current.clear();

    for (const timeout of tableHighlightTimeoutsRef.current.values()) {
      window.clearTimeout(timeout);
    }
    tableHighlightTimeoutsRef.current.clear();

    setSelectedRowId((current) => {
      if (!importResult?.rows.length) {
        return MOCK_SELECTED_ROW_ID;
      }

      return importResult.rows.some((row) => row.id === current)
        ? current
        : importResult.rows[0]?.id ?? null;
    });
  }, [importResult]);

  const statsBarCounts: StatsBarCounts | null = useMemo(() => {
    if (!matchBundle) {
      if (!importResult) return null;
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

  const activeFileName =
    isImported && importResult.debug.fileName
      ? String(importResult.debug.fileName)
      : null;

  const matchResultsForPanel = useMemo(() => {
    if (matchBundle === null) return null;
    return sortLogsNewestFirst(
      matchBundle.logs.filter((log) =>
        doesLogMatchSidebarFilter(log, activeSidebarFilter),
      ),
    );
  }, [activeSidebarFilter, matchBundle]);

  const matchResultsEmptyMessage =
    activeSidebarFilter === "not_checked"
      ? "Not checked is a row filter; there are no event-level results for it."
      : activeSidebarFilter === "all"
        ? "No analytics lines parsed (empty input or no matching markers)."
        : `No ${activeSidebarFilter.replace("_", " ")} analytics lines in this filter.`;

  const processDisabled =
    !importResult?.rows.length || !logText.trim();

  const androidConnectDisabled =
    androidLiveStatus === "connecting" || androidLiveStatus === "live";

  const androidStopDisabled = androidLiveStatus === "disconnected";
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

  const coverageSummaryData = useMemo(() => {
    if (!importResult?.rows.length || !specRowSource) return null;
    const rows = specRowSource;
    const total = rows.length;
    const passedRows = rows.filter((r) => r.status === "matched").length;
    const partialRows = rows.filter((r) => r.status === "partial").length;
    const covered = passedRows + partialRows;
    const coveragePercent =
      total > 0 ? Math.round((covered / total) * 100) : 0;
    const notCheckedRows = rows.filter(
      (r) => r.status === "not_checked",
    ).length;
    return {
      covered,
      total,
      coveragePercent,
      passedRows,
      partialRows,
      notCheckedRows,
    };
  }, [importResult, specRowSource]);

  const showCoverageSummary = isImported && !isEmptyImport;

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
  }, [activeFileName, coverageSummaryData, importResult, matchBundle, specRowSource]);

  const highlightedMatchResultIdSet = new Set(highlightedMatchResultIds);
  const isAndroidMode = activePlatform === "android";
  const isIosMode = activePlatform === "ios";

  return (
    <div className="min-h-screen bg-[#0f1115] p-6 text-[#f3f4f6]">
      <div className="grid h-[calc(100vh-48px)] w-full min-w-0 grid-cols-[64px_240px_minmax(0,1fr)_320px] gap-4 [&>*]:min-h-0 [&>*]:h-full">
        <nav className="flex min-h-0 flex-col items-center gap-2 rounded-2xl border border-[#2a2f3a] bg-[#171923] px-2 py-4 shadow-lg shadow-black/20">
          <p className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-[#6b7280]">
            Mode
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
                onClick={() => setActivePlatform(item.id)}
                className={[
                  "flex h-14 w-full items-center justify-center rounded-xl border px-1 transition",
                  active
                    ? "border-violet-400/45 bg-violet-500/20 text-violet-100 shadow-[inset_0_0_0_1px_rgba(139,92,246,0.16)]"
                    : "border-transparent bg-[#1c1f2a]/70 text-[#9ca3af] hover:border-[#3d4554] hover:text-[#e5e7eb]",
                ].join(" ")}
              >
                {item.id === "android" ? (
                  <AndroidPlatformIcon />
                ) : (
                  <ApplePlatformIcon />
                )}
              </button>
            );
          })}
        </nav>
        <Sidebar
          onSpecFile={handleSpecFile}
          isImporting={isImporting}
          importError={importError}
          importWarnings={importResult?.warnings ?? []}
          activeFileName={activeFileName}
          activeFilter={activeSidebarFilter}
          onFilterChange={setActiveSidebarFilter}
        />
        <main className="flex min-h-0 min-w-0 flex-col gap-4 overflow-hidden rounded-2xl border border-[#2a2f3a] bg-[#171923] p-5 shadow-lg shadow-black/20">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
              <StatsBar counts={statsBarCounts} />
              <button
                type="button"
                onClick={handleResetResults}
                disabled={!importResult}
                className="h-9 shrink-0 rounded-lg border border-[#2a2f3a] bg-[#1c1f2a] px-3 text-xs font-medium text-[#e5e7eb] transition hover:border-[#3d4554] hover:bg-[#232736] disabled:cursor-not-allowed disabled:opacity-45"
                title={
                  !importResult
                    ? "Import a spec to reset results"
                    : "Clear counters and matched results"
                }
              >
                Reset results
              </button>
            </div>
            <button
              type="button"
              onClick={handleExportJson}
              disabled={!importResult}
              className="shrink-0 rounded-xl border border-[#2a2f3a] bg-[#1c1f2a] px-3 py-2 text-xs font-medium text-[#e5e7eb] transition hover:border-[#3d4554] hover:bg-[#232736] disabled:cursor-not-allowed disabled:opacity-45"
              title={!importResult ? "Import a spec to export JSON" : "Download QA session JSON"}
            >
              Export JSON
            </button>
          </div>
          {showCoverageSummary && coverageSummaryData ? (
            <CoverageSummary data={coverageSummaryData} />
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
                  <div className="flex min-w-0 flex-wrap gap-1.5">
                    {eventGroupTabs.map((tab) => {
                      const active = tab.id === activeEventGroupTab;
                      return (
                        <button
                          key={tab.id}
                          type="button"
                          aria-pressed={active}
                          onClick={() => setActiveEventGroupTab(tab.id)}
                          className={[
                            "h-7 rounded-md border px-2.5 text-[11px] font-medium transition",
                            active
                              ? "border-violet-400/55 bg-violet-500/20 text-violet-100"
                              : "border-[#2a2f3a] bg-[#171923] text-[#9ca3af] hover:border-[#3d4554] hover:text-[#e5e7eb]",
                          ].join(" ")}
                        >
                          {tab.label}
                        </button>
                      );
                    })}
                  </div>
                ) : null
              }
              isEmptyImport={isEmptyImport}
              isImported={isImported}
            />
            <div className="grid max-h-[260px] shrink-0 grid-cols-1 gap-3 overflow-hidden xl:h-[150px] xl:max-h-[18vh] xl:grid-cols-[minmax(0,1fr)_minmax(240px,320px)]">
              <div className="flex min-h-[120px] min-w-0 flex-col gap-1.5 overflow-hidden rounded-2xl border border-[#2a2f3a] bg-[#171923] p-2.5 shadow-lg shadow-black/20 xl:h-full xl:min-h-0">
                <h3 className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-[#9ca3af]">
                  Recent results
                </h3>
                <ul
                  ref={recentResultsRef}
                  className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto overflow-x-hidden pr-1"
                >
                  {matchResultsForPanel === null
                    ? MOCK_RECENT_LOG_ITEMS.map((item) => (
                        <li
                          key={item.id}
                          className="shrink-0 rounded-xl border border-[#2a2f3a] bg-[#1c1f2a] p-2"
                        >
                          <div className="flex min-w-0 items-start gap-2">
                            <StatusDot
                              variant={item.status}
                              className="mt-1 shrink-0"
                            />
                            <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-[#d1d5db]">
                              {item.line}
                            </pre>
                          </div>
                        </li>
                      ))
                    : matchResultsForPanel.length === 0 ? (
                        <li className="shrink-0 rounded-xl border border-[#2a2f3a] bg-[#1c1f2a]/50 p-2 text-xs text-[#9ca3af]">
                          {matchResultsEmptyMessage ??
                            "No analytics lines parsed (empty input or no matching markers)."}
                        </li>
                      ) : (
                        matchResultsForPanel.map((entry) => {
                          const highlighted = highlightedMatchResultIdSet.has(
                            entry.id,
                          );
                          return (
                            <li
                              key={entry.id}
                              className={[
                                "shrink-0 rounded-xl border p-2 transition-colors duration-700",
                                highlighted
                                  ? "border-emerald-400/55 bg-emerald-500/[0.12] shadow-[0_0_0_1px_rgba(52,211,153,0.18)]"
                                  : "border-[#2a2f3a] bg-[#1c1f2a]",
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
                                        New
                                      </span>
                                    ) : null}
                                    <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-[#9ca3af]">
                                      {entry.matchType}
                                    </span>
                                    {entry.eventPath ? (
                                      <span className="min-w-0 break-all font-mono text-[11px] text-violet-200/90">
                                        {entry.eventPath}
                                      </span>
                                    ) : null}
                                  </div>
                                  <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-[#d1d5db]">
                                    {entry.extracted ?? entry.raw.trim()}
                                  </pre>
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
                  Selected row details
                </h3>
                {selectedRowDetails ? (
                  <dl className="mt-1 space-y-0.5 text-[11px]">
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-[#9ca3af]">Status</dt>
                      <dd className="flex items-center gap-2 text-right text-[#e5e7eb]">
                        <StatusDot variant={selectedRowDetails.dotStatus} />
                        <span>
                          {translateStatusLabel(selectedRowDetails.statusLabel)}
                        </span>
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="shrink-0 text-[#9ca3af]">Event</dt>
                      <dd className="max-w-[min(100%,36rem)] break-all text-right font-mono text-violet-200/95">
                        {selectedRowDetails.event}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="shrink-0 text-[#9ca3af]">Value</dt>
                      <dd className="max-w-[min(100%,36rem)] break-all text-right font-mono text-[#9ca3af]">
                        {selectedRowDetails.value ?? "-"}
                      </dd>
                    </div>
                    <div className="pt-1 text-[#9ca3af]">
                      {selectedRowDetails.description || "-"}
                    </div>
                  </dl>
                ) : (
                  <p className="mt-2 text-xs text-[#9ca3af]">
                    No row selected
                  </p>
                )}
              </div>
            </div>
          </div>
        </main>
        <div className="flex min-h-0 flex-col gap-3">
          {isAndroidMode ? (
            <div className="flex flex-col gap-2">
              <label className="flex flex-col gap-1 text-xs font-medium text-[#aab2c0]">
                Android package name
                <input
                  type="text"
                  value={androidPackageName}
                  onChange={(e) => handleAndroidPackageNameChange(e.target.value)}
                  placeholder="com.example.app"
                  className="h-9 rounded-lg border border-[#2a2f3a] bg-[#171923] px-3 text-sm text-[#f3f4f6] outline-none transition placeholder:text-[#5d6675] focus:border-[#4b5568]"
                />
              </label>
              <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2">
                <select
                  value={savedAndroidPackageSelectValue}
                  onChange={(e) =>
                    handleAndroidPackageNameChange(e.target.value)
                  }
                  className="h-9 min-w-0 rounded-lg border border-[#2a2f3a] bg-[#171923] px-2 text-xs text-[#f3f4f6] outline-none transition focus:border-[#4b5568]"
                >
                  <option value="" disabled>
                    Saved packages
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
                  className="h-9 rounded-lg border border-[#2a2f3a] bg-[#1c1f2a] px-3 text-xs font-medium text-[#e5e7eb] transition hover:border-[#3d4554] hover:bg-[#232736] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={handleDeleteAndroidPackageName}
                  disabled={deleteAndroidPackageDisabled}
                  className="h-9 rounded-lg border border-[#2a2f3a] bg-[#1c1f2a] px-3 text-xs font-medium text-[#e5e7eb] transition hover:border-red-500/35 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  Delete
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-2 rounded-2xl border border-[#2a2f3a] bg-[#171923] p-3 shadow-lg shadow-black/20">
              <label className="flex flex-col gap-1 text-xs font-medium text-[#aab2c0]">
                iOS bundle id
                <input
                  type="text"
                  value={iosBundleId}
                  onChange={(e) => setIosBundleId(e.target.value)}
                  placeholder="com.example.app"
                  className="h-9 rounded-lg border border-[#2a2f3a] bg-[#171923] px-3 text-sm text-[#f3f4f6] outline-none transition placeholder:text-[#5d6675] focus:border-[#4b5568]"
                />
              </label>
              <p className="text-[11px] leading-snug text-[#9ca3af]">
                iOS live capture is a placeholder for now. Android package
                names are not used in this mode.
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
                isAndroidMode ? androidLiveStatus : "disconnected"
              }
              androidLiveError={isAndroidMode ? androidLiveError : null}
              androidSpecRequiredError={
                isAndroidMode ? androidSpecRequiredError : null
              }
              liveFeedLines={isAndroidMode ? liveFeedLines : []}
              onAndroidConnect={
                isAndroidMode ? handleAndroidConnect : () => undefined
              }
              onAndroidStop={
                isAndroidMode ? handleAndroidStop : () => undefined
              }
              onAndroidClearLive={
                isAndroidMode ? handleClearAndroidLiveLog : () => undefined
              }
              androidConnectDisabled={
                isAndroidMode ? androidConnectDisabled : true
              }
              androidStopDisabled={isAndroidMode ? androidStopDisabled : true}
              liveTitle={isAndroidMode ? "Android Live" : "iOS Live"}
              liveStatusLabel={isIosMode ? "Not ready" : undefined}
              clearLiveLabel={isAndroidMode ? "Clear live" : "Clear iOS"}
              connectLabel={isAndroidMode ? "Connect Android" : "Connect iOS"}
              stopLabel="Stop"
              liveLogLabel={
                isAndroidMode
                  ? "Live log (last 100)"
                  : "iOS live log (placeholder)"
              }
              liveEmptyMessage={
                isAndroidMode
                  ? "No live lines yet. Connect while the game is running."
                  : "iOS live capture is not implemented yet."
              }
              livePlaceholderMessage={
                isIosMode
                  ? "iOS live capture is not wired yet. Paste logs manually below while this mode is being prepared."
                  : null
              }
              liveClearDisabled={isIosMode}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
