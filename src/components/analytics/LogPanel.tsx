import type { StatusDotVariant } from "./StatusDot";

export type SelectedRowDetailsVM = {
  event: string;
  statusLabel: string;
  value: string | null;
  description: string;
  dotStatus: StatusDotVariant;
};

export type AndroidLiveStatus =
  | "disconnected"
  | "connecting"
  | "live"
  | "error";

export type LogPanelProps = {
  logText: string;
  onLogTextChange: (value: string) => void;
  onProcess: () => void;
  onClearLogs: () => void;
  onResetSession: () => void;
  processDisabled: boolean;
  processMessage?: string | null;
  androidLiveStatus: AndroidLiveStatus;
  androidLiveError: string | null;
  androidSpecRequiredError: string | null;
  liveFeedLines: { id: string; text: string }[];
  onAndroidConnect: () => void;
  onAndroidStop: () => void;
  onAndroidClearLive: () => void;
  androidConnectDisabled: boolean;
  androidStopDisabled: boolean;
  liveTitle: string;
  liveStatusLabel?: string;
  clearLiveLabel: string;
  connectLabel: string;
  stopLabel: string;
  liveLogLabel: string;
  liveEmptyMessage: string;
  livePlaceholderMessage?: string | null;
  liveClearDisabled?: boolean;
  livePathLabel?: string;
  livePathValue?: string;
  onLivePathChange?: (value: string) => void;
  livePathPlaceholder?: string;
  livePathHint?: string;
  liveShowAllLinesLabel?: string;
  liveShowAllLinesChecked?: boolean;
  onLiveShowAllLinesChange?: (value: boolean) => void;
  manualEventLabel?: string;
  manualEventValue?: string;
  manualEventPlaceholder?: string;
  manualEventProcessLabel?: string;
  manualEventProcessDisabled?: boolean;
  onManualEventChange?: (value: string) => void;
  onManualEventProcess?: () => void;
  labels: {
    logs: string;
    logsHint: string;
    logPlaceholder: string;
    clearLogs: string;
    resetSession: string;
    process: string;
    statuses: Record<AndroidLiveStatus, string>;
  };
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
  logText,
  onLogTextChange,
  onProcess,
  onClearLogs,
  onResetSession,
  processDisabled,
  processMessage,
  androidLiveStatus,
  androidLiveError,
  androidSpecRequiredError,
  liveFeedLines,
  onAndroidConnect,
  onAndroidStop,
  onAndroidClearLive,
  androidConnectDisabled,
  androidStopDisabled,
  liveTitle,
  liveStatusLabel,
  clearLiveLabel,
  connectLabel,
  stopLabel,
  liveLogLabel,
  liveEmptyMessage,
  livePlaceholderMessage = null,
  liveClearDisabled = false,
  livePathLabel,
  livePathValue = "",
  onLivePathChange,
  livePathPlaceholder,
  livePathHint,
  liveShowAllLinesLabel,
  liveShowAllLinesChecked = false,
  onLiveShowAllLinesChange,
  manualEventLabel,
  manualEventValue = "",
  manualEventPlaceholder,
  manualEventProcessLabel,
  manualEventProcessDisabled = false,
  onManualEventChange,
  onManualEventProcess,
  labels,
}: LogPanelProps) {
  const showManualEventInput =
    Boolean(manualEventLabel) &&
    Boolean(onManualEventChange) &&
    Boolean(onManualEventProcess);
  const showLiveShowAllLinesToggle =
    Boolean(liveShowAllLinesLabel) && Boolean(onLiveShowAllLinesChange);

  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col gap-3 overflow-y-auto overflow-x-hidden pr-1">
      <div className="flex min-h-[300px] flex-1 flex-col space-y-2 rounded-2xl border border-[#2a2f3a] bg-[#171923] p-4 shadow-lg shadow-black/20">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[#9ca3af]">
            {liveTitle}
          </h3>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={liveClearDisabled}
              onClick={onAndroidClearLive}
              className="ui-btn ui-btn-ghost ui-btn-xs"
            >
              {clearLiveLabel}
            </button>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${androidStatusBadgeClass(
                androidLiveStatus,
              )}`}
            >
              {liveStatusLabel ?? labels.statuses[androidLiveStatus]}
            </span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={androidConnectDisabled}
            onClick={onAndroidConnect}
            className="ui-btn ui-btn-primary ui-btn-full"
          >
            {connectLabel}
          </button>
          <button
            type="button"
            disabled={androidStopDisabled}
            onClick={onAndroidStop}
            className="ui-btn ui-btn-danger ui-btn-full"
          >
            {stopLabel}
          </button>
        </div>
        {livePathLabel && onLivePathChange ? (
          <label className="flex flex-col gap-1 text-xs font-medium text-[#aab2c0]">
            {livePathLabel}
            <input
              type="text"
              value={livePathValue}
              onChange={(e) => onLivePathChange(e.target.value)}
              placeholder={livePathPlaceholder}
              className="h-9 rounded-lg border border-[#2a2f3a] bg-[#171923] px-3 text-sm text-[#f3f4f6] outline-none transition placeholder:text-[#5d6675] focus:border-[#4b5568]"
            />
          </label>
        ) : null}
        {livePathHint ? (
          <p className="text-[11px] leading-snug text-[#9ca3af]">
            {livePathHint}
          </p>
        ) : null}
        {showLiveShowAllLinesToggle ? (
          <label className="flex items-center gap-2 text-[11px] font-medium text-[#aab2c0]">
            <input
              type="checkbox"
              checked={liveShowAllLinesChecked}
              onChange={(e) =>
                onLiveShowAllLinesChange?.(e.target.checked)
              }
              className="h-4 w-4 rounded border-[#3d4554] bg-[#171923] accent-violet-500"
            />
            <span>{liveShowAllLinesLabel}</span>
          </label>
        ) : null}
        {showManualEventInput ? (
          <div className="grid gap-1.5 rounded-lg border border-[#2a2f3a] bg-[#11131a]/65 p-2">
            <label className="flex flex-col gap-1 text-xs font-medium text-[#aab2c0]">
              {manualEventLabel}
              <textarea
                rows={2}
                value={manualEventValue}
                onChange={(e) => onManualEventChange?.(e.target.value)}
                placeholder={manualEventPlaceholder}
                className="min-h-[48px] resize-none rounded-lg border border-[#2a2f3a] bg-[#171923] px-3 py-2 font-mono text-xs text-[#f3f4f6] outline-none transition placeholder:text-[#5d6675] focus:border-violet-500/50"
              />
            </label>
            <button
              type="button"
              disabled={manualEventProcessDisabled}
              onClick={onManualEventProcess}
              className="ui-btn ui-btn-primary ui-btn-full ui-btn-sm"
            >
              {manualEventProcessLabel ?? labels.process}
            </button>
          </div>
        ) : null}
        {livePlaceholderMessage ? (
          <p className="text-xs leading-snug text-[#9ca3af]">
            {livePlaceholderMessage}
          </p>
        ) : androidSpecRequiredError ? (
          <p className="text-xs leading-snug text-red-300/90">
            {androidSpecRequiredError}
          </p>
        ) : androidLiveError ? (
          <p className="text-xs leading-snug text-red-300/90">
            {androidLiveError}
          </p>
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col space-y-1">
          <p className="text-[10px] font-medium uppercase tracking-wide text-[#6b7280]">
            {liveLogLabel}
          </p>
          <ul className="min-h-[10rem] flex-1 space-y-1.5 overflow-y-auto overflow-x-hidden rounded-lg border border-[#2a2f3a]/90 bg-[#171923]/80 px-2 py-2 pr-1">
            {liveFeedLines.length === 0 ? (
              <li className="text-[11px] text-[#6b7280]">
                {liveEmptyMessage}
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

      <div className="shrink-0 space-y-1.5 rounded-2xl border border-[#2a2f3a] bg-[#171923] p-2.5 shadow-lg shadow-black/20">
        <div className="mb-1.5">
          <h2 className="text-sm font-semibold text-[#f3f4f6]">
            {labels.logs}
          </h2>
          <p className="mt-0.5 text-xs text-[#9ca3af]">
            {labels.logsHint}
          </p>
        </div>
        <textarea
          rows={1}
          value={logText}
          onChange={(e) => onLogTextChange(e.target.value)}
          placeholder={labels.logPlaceholder}
          className="w-full min-h-[40px] shrink-0 resize-none rounded-xl border border-[#2a2f3a] bg-[#1c1f2a] px-3 py-1.5 text-xs text-[#f3f4f6] placeholder:text-[#6b7280] focus:border-violet-500/50 focus:outline-none focus:ring-2 focus:ring-violet-500/20"
        />

        <div className="grid shrink-0 grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onClearLogs}
            className="ui-btn ui-btn-secondary ui-btn-sm ui-btn-full"
          >
            {labels.clearLogs}
          </button>
          <button
            type="button"
            onClick={onResetSession}
            className="ui-btn ui-btn-ghost ui-btn-sm ui-btn-full"
          >
            {labels.resetSession}
          </button>
        </div>

        <button
          type="button"
          disabled={processDisabled}
          onClick={onProcess}
          className="ui-btn ui-btn-primary ui-btn-full shrink-0"
        >
          {labels.process}
        </button>

        {processMessage ? (
          <p className="shrink-0 text-xs text-amber-200/90">
            {processMessage}
          </p>
        ) : null}
      </div>
    </aside>
  );
}
