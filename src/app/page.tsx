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
import type { SidebarFilter } from "@/components/analytics/Sidebar";
import { specToTableRowModel } from "@/components/analytics/specRowDisplay";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type AndroidLiveStatus =
  | "disconnected"
  | "connecting"
  | "live"
  | "error";

type PlatformMode = "android" | "ios" | "unity";

type EventGroupTabId =
  | "all"
  | "subscription"
  | "tracking_confirmed"
  | "inapp"
  | "tracking_purchase"
  | "funnel";

const androidPackageNamesStorageKey = "analytics-checker.androidPackageNames";
const uiLanguageStorageKey = "analytics-checker.uiLanguage";
const liveHardDuplicateWindowMs = 250;

type UiLanguage = "en" | "ru";

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

const eventGroupTabs: Array<{ id: EventGroupTabId; label: string }> = [
  { id: "all", label: "All events" },
  { id: "subscription", label: "Subscription" },
  { id: "tracking_confirmed", label: "Tracking confirmed" },
  { id: "inapp", label: "In-app" },
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

const uiLabels = {
  en: {
    mode: "Mode",
    import: "Import",
    importFailed: "Import failed",
    uploadSpec: "Upload spec (.xlsx / .csv)",
    reading: "Reading...",
    loadedSpec: "Loaded spec",
    ready: "Ready",
    warnings: "Warnings",
    more: "more",
    filters: "Filters",
    filterLabels: {
      all: "All",
      passed: "Passed",
      duplicate: "Duplicate",
      unknown: "Unknown",
      not_checked: "Not checked",
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
      importSpecToExportJson: "Import a spec to export JSON",
      downloadJson: "Download QA session JSON",
    },
    recentResults: "Recent Results",
    selectedRowDetails: "Selected Row Details",
    noRowSelected: "No row selected",
    new: "New",
    noSpecLoaded:
      "No spec loaded. Upload a spec file to start analytics validation.",
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
    },
    unity: {
      liveTitle: "Unity Live",
      connect: "Connect Unity",
      liveLog: "Unity live log (last 100)",
      noLiveLines:
        "No Unity live lines yet. Connect while Unity Editor is running.",
      logPath: "Unity Editor log path",
      logPathHint: "Leave empty to use the default Unity Editor.log path.",
      startFailed: "Unity start failed",
      connectFailed: "Unity connect failed",
      liveDisconnected: "Unity live stream disconnected",
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
    import: "Импорт",
    importFailed: "Не удалось импортировать файл",
    uploadSpec: "Загрузить spec (.xlsx / .csv)",
    reading: "Чтение...",
    loadedSpec: "Загруженный spec",
    ready: "Готово",
    warnings: "Предупреждения",
    more: "ещё",
    filters: "Фильтры",
    filterLabels: {
      all: "Все",
      passed: "Пройдено",
      duplicate: "Дубликат",
      unknown: "Неизвестно",
      not_checked: "Не проверено",
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
      importSpecToExportJson: "Загрузите spec для экспорта JSON",
      downloadJson: "Скачать JSON QA-сессии",
    },
    recentResults: "Последние события",
    selectedRowDetails: "Детали выбранной строки",
    noRowSelected: "Строка не выбрана",
    new: "Новое",
    noSpecLoaded:
      "Спецификация не загружена. Загрузите файл spec, чтобы начать проверку аналитики.",
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
    },
    unity: {
      liveTitle: "Unity лог",
      connect: "Подключить Unity",
      liveLog: "Unity live-лог (последние 100)",
      noLiveLines:
        "Unity live-строк пока нет. Подключитесь, пока Unity Editor запущен.",
      logPath: "Путь к Unity Editor log",
      logPathHint:
        "Оставьте пустым, чтобы использовать стандартный путь Unity Editor.log.",
      startFailed: "Не удалось запустить Unity",
      connectFailed: "Не удалось подключить Unity",
      liveDisconnected: "Unity live-поток отключился",
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
  import: string;
  importFailed: string;
  uploadSpec: string;
  reading: string;
  loadedSpec: string;
  ready: string;
  warnings: string;
  more: string;
  filters: string;
  filterLabels: Record<SidebarFilter, string>;
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
    importSpecToExportJson: string;
    downloadJson: string;
  };
  recentResults: string;
  selectedRowDetails: string;
  noRowSelected: string;
  new: string;
  noSpecLoaded: string;
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
  };
  unity: {
    liveTitle: string;
    connect: string;
    liveLog: string;
    noLiveLines: string;
    logPath: string;
    logPathHint: string;
    startFailed: string;
    connectFailed: string;
    liveDisconnected: string;
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
    return [];
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
  const [uiLanguage, setUiLanguage] = useState<UiLanguage>("en");
  const [uiLanguageLoaded, setUiLanguageLoaded] = useState(false);
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
  const [unityLogPath, setUnityLogPath] = useState("");
  const [unityLiveStatus, setUnityLiveStatus] =
    useState<AndroidLiveStatus>("disconnected");
  const [unityLiveError, setUnityLiveError] = useState<string | null>(null);
  const [unityLiveFeedLines, setUnityLiveFeedLines] = useState<
    { id: string; text: string }[]
  >([]);
  const [selectedUnityLiveFeedLineId, setSelectedUnityLiveFeedLineId] =
    useState<string | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  const iosEventSourceRef = useRef<EventSource | null>(null);
  const unityEventSourceRef = useRef<EventSource | null>(null);
  const liveFeedScrollRef = useRef<HTMLElement | null>(null);
  const recentResultsRef = useRef<HTMLUListElement | null>(null);
  const importResultRef = useRef(importResult);
  const originalWorkbookBufferRef = useRef<ArrayBuffer | null>(null);
  const androidLiveContextRef = useRef(0);
  const knownMatchResultIdsRef = useRef<Set<string>>(new Set());
  const highlightTimeoutsRef = useRef<Map<string, number>>(new Map());
  const knownTableLogIdsRef = useRef<Set<string>>(new Set());
  const tableHighlightTimeoutsRef = useRef<Map<string, number>>(new Map());
  const labels = uiLabels[uiLanguage];
  importResultRef.current = importResult;

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
      return null;
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
      const originalWorkbookBuffer = await file.arrayBuffer();
      const importFile = new File([originalWorkbookBuffer], file.name, {
        lastModified: file.lastModified,
        type: file.type,
      });
      const res = await importSpec(importFile);
      originalWorkbookBufferRef.current = originalWorkbookBuffer;
      setImportResult(res);
      setAndroidSpecRequiredError(null);
      clearSessionResults();
      setSelectedRowId(null);
      clearAndroidLiveContext("spec change");
    } catch (e) {
      setImportError(e instanceof Error ? e.message : labels.importFailed);
    } finally {
      setIsImporting(false);
    }
  }, [clearAndroidLiveContext, clearSessionResults, labels]);

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

  const handleClearIosLive = useCallback(() => {
    setIosLiveFeedLines([]);
    setSelectedLiveFeedLineId(null);
    void fetch("/api/ios/clear", { method: "POST" }).catch((e) => {
      console.warn("[ios-live] failed to clear backend buffer", e);
    });
  }, []);

  const handleUnityConnect = useCallback(async () => {
    setUnityLiveError(null);
    setUnityLiveStatus("connecting");
    setUnityLiveFeedLines([]);
    setSelectedUnityLiveFeedLineId(null);
    unityEventSourceRef.current?.close();
    unityEventSourceRef.current = null;

    try {
      const logPathOverride = unityLogPath.trim() || undefined;
      const res = await fetch("/api/unity/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logPath: logPathOverride }),
      });
      const data: { success?: boolean; error?: string } = await res.json();
      if (!data.success) {
        setUnityLiveError(data.error ?? labels.unity.startFailed);
        setUnityLiveStatus("error");
        return;
      }

      const es = new EventSource("/api/unity/stream");
      unityEventSourceRef.current = es;

      es.onopen = () => {
        if (unityEventSourceRef.current !== es) {
          return;
        }
        setUnityLiveStatus("live");
      };

      es.onmessage = (ev) => {
        if (unityEventSourceRef.current !== es) {
          return;
        }
        const line = ev.data ?? "";
        if (!line) {
          return;
        }
        const displayLine = toDisplayLiveLine(line);
        setUnityLiveFeedLines((prev) => {
          const id = nextLiveLogId();
          return [...prev, { id, text: displayLine || line.trim() }].slice(-100);
        });
        appendLiveAnalyticsLine(line);
      };

      es.onerror = () => {
        if (unityEventSourceRef.current !== es) {
          es.close();
          return;
        }
        setUnityLiveError(labels.unity.liveDisconnected);
        setUnityLiveStatus("error");
        es.close();
        if (unityEventSourceRef.current === es) {
          unityEventSourceRef.current = null;
        }
      };
    } catch (e) {
      setUnityLiveError(
        e instanceof Error ? e.message : labels.unity.connectFailed,
      );
      setUnityLiveStatus("error");
    }
  }, [appendLiveAnalyticsLine, labels, unityLogPath]);

  const handleUnityStop = useCallback(async () => {
    unityEventSourceRef.current?.close();
    unityEventSourceRef.current = null;
    try {
      await fetch("/api/unity/stop", { method: "POST" });
    } catch {
      /* ignore */
    }
    setUnityLiveStatus("disconnected");
    setUnityLiveError(null);
  }, []);

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
      unityEventSourceRef.current?.close();
      unityEventSourceRef.current = null;
      void fetch("/api/android/stop", { method: "POST" });
      void fetch("/api/ios/stop", { method: "POST" });
      void fetch("/api/unity/stop", { method: "POST" });
    };
  }, []);

  const visibleLiveFeedLines =
    activePlatform === "unity"
      ? unityLiveFeedLines
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
    if (importResult?.rows.length) {
      setSelectedRowId(importResult.rows[0]?.id ?? null);
    } else {
      setSelectedRowId(null);
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
        return null;
      }

      return importResult.rows.some((row) => row.id === current)
        ? current
        : importResult.rows[0]?.id ?? null;
    });
  }, [importResult]);

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
      ? labels.noNotCheckedEventResults
      : activeSidebarFilter === "all"
        ? labels.noAnalyticsLinesParsed
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
  const usedSheetNameForCheckedExport = importResult?.debug.usedSheetName;
  const checkColumnIndexForCheckedExport = importResult?.debug.checkColumnIndex;
  const canExportCheckedXlsx =
    !isImporting &&
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
  const isUnityMode = activePlatform === "unity";

  return (
    <div className="min-h-screen bg-[#0f1115] p-6 text-[#f3f4f6]">
      <div className="grid h-[calc(100vh-48px)] w-full min-w-0 grid-cols-[64px_240px_minmax(0,1fr)_320px] gap-4 [&>*]:min-h-0 [&>*]:h-full">
        <nav className="flex min-h-0 flex-col items-center gap-2 rounded-2xl border border-[#2a2f3a] bg-[#171923] px-2 py-4 shadow-lg shadow-black/20">
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
                ) : item.id === "ios" ? (
                  <ApplePlatformIcon />
                ) : (
                  <UnityPlatformIcon />
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
          labels={{
            import: labels.import,
            reading: labels.reading,
            uploadSpec: labels.uploadSpec,
            loadedSpec: labels.loadedSpec,
            ready: labels.ready,
            warnings: labels.warnings,
            more: labels.more,
            filters: labels.filters,
            filterLabels: labels.filterLabels,
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
                className="h-9 shrink-0 rounded-lg border border-[#2a2f3a] bg-[#1c1f2a] px-3 text-xs font-medium text-[#e5e7eb] transition hover:border-[#3d4554] hover:bg-[#232736] disabled:cursor-not-allowed disabled:opacity-45"
                title={
                  !importResult
                    ? labels.titles.importSpecToReset
                    : labels.titles.clearCounters
                }
              >
                {labels.buttons.resetResults}
              </button>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
              <div className="grid h-9 grid-cols-2 rounded-lg border border-[#2a2f3a] bg-[#171923] p-0.5">
                {(["en", "ru"] as const).map((language) => {
                  const active = language === uiLanguage;
                  return (
                    <button
                      key={language}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setUiLanguage(language)}
                      className={[
                        "rounded-md px-2 text-[11px] font-semibold uppercase transition",
                        active
                          ? "bg-violet-500/25 text-violet-100"
                          : "text-[#9ca3af] hover:text-[#e5e7eb]",
                      ].join(" ")}
                    >
                      {language.toUpperCase()}
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                onClick={handleExportCheckedXlsx}
                disabled={!canExportCheckedXlsx}
                className="shrink-0 rounded-xl border border-[#2a2f3a] bg-[#1c1f2a] px-3 py-2 text-xs font-medium text-[#e5e7eb] transition hover:border-[#3d4554] hover:bg-[#232736] disabled:cursor-not-allowed disabled:opacity-45"
                title={
                  canExportCheckedXlsx
                    ? labels.titles.downloadCheckedXlsx
                    : labels.titles.importWorkbookForCheckedXlsx
                }
              >
                {labels.buttons.exportCheckedXlsx}
              </button>
              <button
                type="button"
                onClick={handleExportJson}
                disabled={!importResult}
                className="shrink-0 rounded-xl border border-[#2a2f3a] bg-[#1c1f2a] px-3 py-2 text-xs font-medium text-[#e5e7eb] transition hover:border-[#3d4554] hover:bg-[#232736] disabled:cursor-not-allowed disabled:opacity-45"
                title={
                  !importResult
                    ? labels.titles.importSpecToExportJson
                    : labels.titles.downloadJson
                }
              >
                {labels.buttons.exportJson}
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
                  {matchResultsForPanel === null ? (
                    <li className="shrink-0 rounded-xl border border-[#2a2f3a] bg-[#1c1f2a]/50 p-2 text-xs text-[#9ca3af]">
                      {labels.noSpecLoaded}
                    </li>
                  ) : matchResultsForPanel.length === 0 ? (
                        <li className="shrink-0 rounded-xl border border-[#2a2f3a] bg-[#1c1f2a]/50 p-2 text-xs text-[#9ca3af]">
                          {matchResultsEmptyMessage}
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
                    className="h-9 rounded-lg border border-[#2a2f3a] bg-[#1c1f2a] px-3 text-xs font-medium text-[#e5e7eb] transition hover:border-[#3d4554] hover:bg-[#232736] disabled:cursor-not-allowed disabled:opacity-45"
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
                  className="h-9 rounded-lg border border-[#2a2f3a] bg-[#1c1f2a] px-3 text-xs font-medium text-[#e5e7eb] transition hover:border-[#3d4554] hover:bg-[#232736] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {labels.buttons.save}
                </button>
                <button
                  type="button"
                  onClick={handleDeleteAndroidPackageName}
                  disabled={deleteAndroidPackageDisabled}
                  className="h-9 rounded-lg border border-[#2a2f3a] bg-[#1c1f2a] px-3 text-xs font-medium text-[#e5e7eb] transition hover:border-red-500/35 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-45"
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
              liveFeedLines={
                isAndroidMode
                  ? liveFeedLines
                  : isUnityMode
                    ? unityLiveFeedLines
                    : iosLiveFeedLines
              }
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
              liveStatusLabel={undefined}
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
                    ? labels.unity.noLiveLines
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
                  ? labels.unity.logPathHint
                  : undefined
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
    </div>
  );
}
