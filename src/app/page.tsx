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
  MissingEventsBlock,
  Sidebar,
  StatsBar,
} from "@/components/analytics";
import type { StatsBarCounts } from "@/components/analytics/StatsBar";
import { MOCK_SELECTED_ROW_ID, MOCK_TABLE_ROWS } from "@/components/analytics/mock-ui";
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

function seedPassedKeysFromLogs(logs: ParsedLogEntry[]): Set<string> {
  const seen = new Set<string>();
  for (const log of logs) {
    if (
      log.matchType === "passed" &&
      log.matchedRowId &&
      log.extracted != null
    ) {
      seen.add(`${log.matchedRowId}::${normalizeValue(log.extracted)}`);
    }
  }
  return seen;
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
  const [androidLiveStatus, setAndroidLiveStatus] =
    useState<AndroidLiveStatus>("disconnected");
  const [androidLiveError, setAndroidLiveError] = useState<string | null>(null);
  const [liveFeedLines, setLiveFeedLines] = useState<
    { id: string; text: string }[]
  >([]);
  const [selectedLiveFeedLineId, setSelectedLiveFeedLineId] = useState<
    string | null
  >(null);
  const [iosLiveStatus, setIosLiveStatus] =
    useState<AndroidLiveStatus>("disconnected");
  const [iosLiveError, setIosLiveError] = useState<string | null>(null);
  const [iosLiveFeedLines, setIosLiveFeedLines] = useState<
    { id: string; text: string }[]
  >([]);

  const eventSourceRef = useRef<EventSource | null>(null);
  const iosEventSourceRef = useRef<EventSource | null>(null);
  const liveFeedScrollRef = useRef<HTMLElement | null>(null);
  const importResultRef = useRef(importResult);
  importResultRef.current = importResult;

  const resolveLiveFeedScrollElement = useCallback(() => {
    if (liveFeedScrollRef.current) {
      return liveFeedScrollRef.current;
    }
    const labels = Array.from(document.querySelectorAll("p"));
    const liveLabel = labels.find((el) =>
      el.textContent?.trim().toLowerCase().includes("live log (last 100)"),
    );
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

  const specRowSource: AnalyticsSpecRow[] | null = useMemo(() => {
    if (importResult === null) return null;
    return matchBundle?.rows ?? importResult.rows;
  }, [importResult, matchBundle]);

  const tableRows = useMemo(
    () => buildTableRows(importResult, specRowSource),
    [importResult, specRowSource],
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

  const handleSpecFile = useCallback(async (file: File) => {
    setIsImporting(true);
    setImportError(null);
    try {
      const res = await importSpec(file);
      setImportResult(res);
      setMatchBundle(null);
      setProcessMessage(null);
      setSelectedRowId(res.rows[0]?.id ?? null);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setIsImporting(false);
    }
  }, []);

  const handleProcess = useCallback(() => {
    if (!importResult?.rows.length || !logText.trim()) {
      return;
    }
    const { logs, rows } = matchLogLinesAgainstSpec(
      logText,
      importResult.rows,
    );
    const stats = computeStats(rows, logs);
    setMatchBundle({ logs, rows, stats });
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

      const seenPassed = seedPassedKeysFromLogs(logs);
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

      if (matchType === "passed" && m.matchedRowId) {
        const dupKey = `${m.matchedRowId}::${normalizeValue(cleanedExtracted)}`;
        if (seenPassed.has(dupKey)) {
          matchType = "duplicate";
          reason = "Duplicate log (same row + payload as earlier line)";
        } else {
          seenPassed.add(dupKey);
        }
      }

      const entry: ParsedLogEntry = {
        id: nextLiveLogId(),
        raw: rawLine,
        extracted: cleanedExtracted,
        eventPath: m.eventPath,
        value: m.value,
        timestamp: Date.now(),
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
    setAndroidLiveError(null);
    setAndroidLiveStatus("connecting");
    try {
      const res = await fetch("/api/android/start", { method: "POST" });
      const data: { success?: boolean; error?: string } = await res.json();
      if (!data.success) {
        setAndroidLiveError(data.error ?? "Android start failed");
        setAndroidLiveStatus("error");
        return;
      }

      eventSourceRef.current?.close();
      const es = new EventSource("/api/android/stream");
      eventSourceRef.current = es;

      es.onopen = () => {
        setAndroidLiveStatus("live");
      };

      es.onmessage = (ev) => {
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
        setAndroidLiveError("Live stream disconnected");
        setAndroidLiveStatus("error");
        es.close();
        if (eventSourceRef.current === es) {
          eventSourceRef.current = null;
        }
      };
    } catch (e) {
      setAndroidLiveError(
        e instanceof Error ? e.message : "Android connect failed",
      );
      setAndroidLiveStatus("error");
    }
  }, [appendLiveAnalyticsLine]);

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

  const handleAndroidStop = useCallback(async () => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setLiveFeedLines([]);
    setSelectedLiveFeedLineId(null);
    try {
      await fetch("/api/android/stop", { method: "POST" });
    } catch {
      /* ignore */
    }
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

  const statsBarCounts: StatsBarCounts | null = useMemo(() => {
    if (!matchBundle) return null;
    const passedLogs = matchBundle.logs.filter(
      (l) => l.matchType === "passed",
    ).length;
    return {
      passedLogs,
      duplicateLogs: matchBundle.stats.logStats.duplicateLogs,
      unknownLogs: matchBundle.stats.logStats.unknownLogs,
      partialLogs: matchBundle.stats.logStats.partialLogs,
      notCheckedRows: matchBundle.stats.rowStats.notChecked,
    };
  }, [matchBundle]);

  const activeFileName =
    isImported && importResult.debug.fileName
      ? String(importResult.debug.fileName)
      : null;

  const matchResultsForPanel =
    matchBundle === null ? null : matchBundle.logs;

  const unknownLogsForPanel = useMemo(() => {
    if (!matchBundle) return [];
    return matchBundle.logs.filter((l) => l.matchType === "unknown");
  }, [matchBundle]);

  const processDisabled =
    !importResult?.rows.length || !logText.trim();

  const androidConnectDisabled =
    !importResult?.rows.length ||
    androidLiveStatus === "connecting" ||
    androidLiveStatus === "live";

  const androidStopDisabled = androidLiveStatus === "disconnected";

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

  const missingSpecRows = useMemo(() => {
    if (!importResult?.rows.length || !specRowSource) return [];
    return specRowSource.filter((r) => r.status === "not_checked");
  }, [importResult, specRowSource]);

  const showCoverageAndMissing = isImported && !isEmptyImport;

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

  return (
    <div className="min-h-screen bg-[#0f1115] p-6 text-[#f3f4f6]">
      <div className="grid h-[calc(100vh-48px)] w-full min-w-0 grid-cols-[240px_minmax(0,1fr)_320px] gap-4 [&>*]:min-h-0 [&>*]:h-full">
        <Sidebar
          onSpecFile={handleSpecFile}
          isImporting={isImporting}
          importError={importError}
          importWarnings={importResult?.warnings ?? []}
          activeFileName={activeFileName}
        />
        <main className="flex min-h-0 min-w-0 flex-col gap-4 overflow-hidden rounded-2xl border border-[#2a2f3a] bg-[#171923] p-5 shadow-lg shadow-black/20">
          <div className="flex items-center justify-between gap-3">
            <StatsBar counts={statsBarCounts} />
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
          {showCoverageAndMissing && coverageSummaryData ? (
            <CoverageSummary data={coverageSummaryData} />
          ) : null}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden">
            <AnalyticsTable
              rows={tableRows}
              selectedRowId={selectedRowId}
              onSelectRow={setSelectedRowId}
              isEmptyImport={isEmptyImport}
              isImported={isImported}
            />
            {showCoverageAndMissing ? (
              <MissingEventsBlock rows={missingSpecRows} />
            ) : null}
          </div>
        </main>
        <LogPanel
          selectedRowDetails={selectedRowDetails}
          logText={logText}
          onLogTextChange={setLogText}
          onProcess={handleProcess}
          onClearLogs={handleClearLogs}
          onResetSession={handleResetSession}
          processDisabled={processDisabled}
          matchResults={matchResultsForPanel}
          unknownLogs={unknownLogsForPanel}
          processMessage={processMessage}
          androidLiveStatus={androidLiveStatus}
          androidLiveError={androidLiveError}
          liveFeedLines={liveFeedLines}
          onAndroidConnect={handleAndroidConnect}
          onAndroidStop={handleAndroidStop}
          androidConnectDisabled={androidConnectDisabled}
          androidStopDisabled={androidStopDisabled}
        />
      </div>
    </div>
  );
}
