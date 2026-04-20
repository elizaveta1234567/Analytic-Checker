import type { ParsedLogEntry } from "@/lib/analytics/types";
import { StatusDot } from "./StatusDot";
import { MOCK_RECENT_LOG_ITEMS } from "./mock-ui";
import type { StatusDotVariant } from "./StatusDot";

export type SelectedRowDetailsVM = {
  event: string;
  statusLabel: string;
  value: string | null;
  description: string;
  dotStatus: StatusDotVariant;
};

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

export type AndroidLiveStatus =
  | "disconnected"
  | "connecting"
  | "live"
  | "error";

export type LogPanelProps = {
  selectedRowDetails: SelectedRowDetailsVM | null;
  logText: string;
  onLogTextChange: (value: string) => void;
  onProcess: () => void;
  onClearLogs: () => void;
  onResetSession: () => void;
  processDisabled: boolean;
  /** null = show mock recent items; array = matcher output (may be empty). */
  matchResults: ParsedLogEntry[] | null;
  /** Shown when `matchResults !== null`. */
  unknownLogs: ParsedLogEntry[];
  processMessage?: string | null;
  androidLiveStatus: AndroidLiveStatus;
  androidLiveError: string | null;
  liveFeedLines: { id: string; text: string }[];
  onAndroidConnect: () => void;
  onAndroidStop: () => void;
  androidConnectDisabled: boolean;
  androidStopDisabled: boolean;
};

function androidStatusBadgeClass(status: AndroidLiveStatus): string {
  switch (status) {
    case "live":
      return "border border-emerald-500/35 bg-emerald-500/15 text-emerald-200";
    case "connecting":
      return "border border-amber-500/35 bg-amber-500/15 text-amber-200";
    case "error":
      return "border border-red-500/35 bg-red-500/15 text-red-200";
    default:
      return "border border-[#3d4554] bg-[#1c1f2a] text-[#9ca3af]";
  }
}

export function LogPanel({
  selectedRowDetails,
  logText,
  onLogTextChange,
  onProcess,
  onClearLogs,
  onResetSession,
  processDisabled,
  matchResults,
  unknownLogs,
  processMessage,
  androidLiveStatus,
  androidLiveError,
  liveFeedLines,
  onAndroidConnect,
  onAndroidStop,
  androidConnectDisabled,
  androidStopDisabled,
}: LogPanelProps) {
  const showUnknownSection = matchResults !== null;

  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-[#2a2f3a] bg-[#171923] shadow-lg shadow-black/20">
      <div className="shrink-0 border-b border-[#2a2f3a] px-5 pb-4 pt-5">
        <h2 className="text-sm font-semibold text-[#f3f4f6]">Logs</h2>
        <p className="mt-0.5 text-xs text-[#9ca3af]">
          Paste console lines, then Process
        </p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-5 py-4">
        <textarea
          rows={6}
          value={logText}
          onChange={(e) => onLogTextChange(e.target.value)}
          placeholder="Paste debug console lines here…"
          className="w-full min-h-[120px] shrink-0 resize-none rounded-xl border border-[#2a2f3a] bg-[#1c1f2a] px-3 py-2.5 text-xs text-[#f3f4f6] placeholder:text-[#6b7280] focus:border-violet-500/50 focus:outline-none focus:ring-2 focus:ring-violet-500/20"
        />

        <div className="grid shrink-0 grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onClearLogs}
            className="rounded-xl border border-[#2a2f3a] bg-[#1c1f2a] px-3 py-2 text-xs font-medium text-[#e5e7eb] transition hover:border-[#3d4554] hover:bg-[#232736]"
          >
            Clear logs
          </button>
          <button
            type="button"
            onClick={onResetSession}
            className="rounded-xl border border-[#2a2f3a] bg-[#1c1f2a] px-3 py-2 text-xs font-medium text-[#e5e7eb] transition hover:border-amber-500/35 hover:bg-amber-500/10"
          >
            Reset session
          </button>
        </div>

        <button
          type="button"
          disabled={processDisabled}
          onClick={onProcess}
          className="w-full shrink-0 rounded-xl border border-violet-500/40 bg-violet-600/20 px-3 py-2.5 text-sm font-medium text-violet-100 transition hover:bg-violet-600/30 focus:outline-none focus:ring-2 focus:ring-violet-500/30 disabled:cursor-not-allowed disabled:opacity-45"
        >
          Process
        </button>

        {processMessage ? (
          <p className="shrink-0 text-xs text-amber-200/90">{processMessage}</p>
        ) : null}

        <div className="shrink-0 space-y-2 rounded-xl border border-[#2a2f3a] bg-[#1c1f2a]/80 p-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[#9ca3af]">
              Android live
            </h3>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${androidStatusBadgeClass(
                androidLiveStatus,
              )}`}
            >
              {androidLiveStatus}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={androidConnectDisabled}
              onClick={onAndroidConnect}
              className="rounded-xl border border-emerald-500/40 bg-emerald-600/15 px-3 py-2 text-xs font-medium text-emerald-100 transition hover:bg-emerald-600/25 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-45"
            >
              Connect Android
            </button>
            <button
              type="button"
              disabled={androidStopDisabled}
              onClick={onAndroidStop}
              className="rounded-xl border border-[#2a2f3a] bg-[#1c1f2a] px-3 py-2 text-xs font-medium text-[#e5e7eb] transition hover:border-red-500/35 hover:bg-red-500/10 focus:outline-none focus:ring-2 focus:ring-red-500/25 disabled:cursor-not-allowed disabled:opacity-45"
            >
              Stop
            </button>
          </div>
          {androidLiveError ? (
            <p className="text-xs leading-snug text-red-300/90">{androidLiveError}</p>
          ) : null}
          <div className="space-y-1">
            <p className="text-[10px] font-medium uppercase tracking-wide text-[#6b7280]">
              Live log (last 100)
            </p>
            <ul className="max-h-40 min-h-[4rem] space-y-1.5 overflow-y-auto overflow-x-hidden rounded-lg border border-[#2a2f3a]/90 bg-[#171923]/80 px-2 py-2 pr-1">
              {liveFeedLines.length === 0 ? (
                <li className="text-[11px] text-[#6b7280]">
                  No live lines yet. Connect while the game is running.
                </li>
              ) : (
                liveFeedLines.map(({ id, text }) => (
                  <li
                    key={id}
                    className="border-b border-[#2a2f3a]/50 pb-1.5 last:border-b-0 last:pb-0"
                  >
                    <pre className="whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-[#d1d5db]">
                      {text}
                    </pre>
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
          <h3 className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-[#9ca3af]">
            Recent results
          </h3>
          <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden pr-1">
            {matchResults === null
              ? MOCK_RECENT_LOG_ITEMS.map((item) => (
                  <li
                    key={item.id}
                    className="shrink-0 rounded-xl border border-[#2a2f3a] bg-[#1c1f2a] p-2.5"
                  >
                    <div className="flex min-w-0 items-start gap-2">
                      <StatusDot variant={item.status} className="mt-1 shrink-0" />
                      <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-[#d1d5db]">
                        {item.line}
                      </pre>
                    </div>
                  </li>
                ))
              : matchResults.length === 0 ? (
                  <li className="shrink-0 rounded-xl border border-[#2a2f3a] bg-[#1c1f2a]/50 p-3 text-xs text-[#9ca3af]">
                    No analytics lines parsed (empty input or no matching
                    markers).
                  </li>
                ) : (
                  matchResults.map((entry) => (
                    <li
                      key={entry.id}
                      className="shrink-0 rounded-xl border border-[#2a2f3a] bg-[#1c1f2a] p-2.5"
                    >
                      <div className="flex min-w-0 items-start gap-2">
                        <StatusDot
                          variant={matchTypeToDot(entry.matchType)}
                          className="mt-1 shrink-0"
                        />
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
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
                  ))
                )}
          </ul>
        </div>

        {showUnknownSection ? (
          <div className="flex max-h-[min(180px,28vh)] shrink-0 flex-col gap-2 overflow-hidden rounded-xl border border-[#2a2f3a] bg-[#1c1f2a]/60 p-2.5">
            <h3 className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-red-300/90">
              Unknown events
            </h3>
            <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto overflow-x-hidden pr-1">
              {unknownLogs.length === 0 ? (
                <li className="text-xs text-[#9ca3af]">No unknown log lines</li>
              ) : (
                unknownLogs.map((entry) => (
                  <li
                    key={entry.id}
                    className="rounded-lg border border-[#2a2f3a]/90 bg-[#171923]/90 px-2.5 py-2"
                  >
                    <p className="text-[10px] font-medium uppercase tracking-wide text-[#9ca3af]">
                      Unknown
                    </p>
                    <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-[#f3f4f6]">
                      {entry.extracted ?? entry.raw.trim()}
                    </pre>
                    <p className="mt-1 text-[10px] text-[#9ca3af]">
                      {entry.reason ?? "—"}
                    </p>
                  </li>
                ))
              )}
            </ul>
          </div>
        ) : null}

        <div className="shrink-0 rounded-xl border border-[#2a2f3a] bg-[#1c1f2a] p-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[#9ca3af]">
            Selected row details
          </h3>
          {selectedRowDetails ? (
            <dl className="mt-2 space-y-1.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[#9ca3af]">Status</dt>
                <dd className="flex items-center gap-2 text-right text-[#e5e7eb]">
                  <StatusDot variant={selectedRowDetails.dotStatus} />
                  <span className="capitalize">
                    {selectedRowDetails.statusLabel}
                  </span>
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="shrink-0 text-[#9ca3af]">Event</dt>
                <dd className="max-w-[min(100%,12rem)] break-all text-right font-mono text-violet-200/95">
                  {selectedRowDetails.event}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="shrink-0 text-[#9ca3af]">Value</dt>
                <dd className="max-w-[min(100%,12rem)] break-all text-right font-mono text-[#9ca3af]">
                  {selectedRowDetails.value ?? "—"}
                </dd>
              </div>
              <div className="pt-1 text-[#9ca3af]">
                {selectedRowDetails.description || "—"}
              </div>
            </dl>
          ) : (
            <p className="mt-2 text-xs text-[#9ca3af]">No row selected</p>
          )}
        </div>
      </div>
    </aside>
  );
}
