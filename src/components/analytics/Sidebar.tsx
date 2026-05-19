"use client";

import { useRef } from "react";

const sectionTitle =
  "mb-2 text-[11px] font-semibold uppercase tracking-wider text-[#9ca3af]";

export type SidebarFilter =
  | "all"
  | "passed"
  | "duplicate"
  | "unknown"
  | "not_checked";

export type SidebarSheetSyncStatus =
  | "idle"
  | "pending"
  | "syncing"
  | "synced"
  | "failed";

export type SidebarProps = {
  onSpecFile: (file: File) => void;
  onGoogleSheetImport: () => void;
  onGoogleSheetImportCancel: () => void;
  onGoogleSheetUrlChange: (url: string) => void;
  onGoogleConnect: () => void;
  onGoogleReconnect: () => void;
  onAutoUpdateGoogleSheetChange: (enabled: boolean) => void;
  onPreviewGoogleSheetWriteTargetsChange: (enabled: boolean) => void;
  onRebuildGoogleRowIndex: () => void;
  onRetryGoogleSheetCheckboxDetection: () => void;
  onManualCheckboxColumnChange: (value: string) => void;
  onManualSheetTitleChange: (value: string) => void;
  onSaveManualSheetTitle: () => void;
  onUseManualCheckboxColumn: () => void;
  onTestGoogleSheetWrite: () => void;
  onTestGoogleSheetExactG69: () => void;
  onTestGoogleSheetExactG85: () => void;
  onSyncPendingGoogleSheetNow: () => void;
  onExportCheckedXlsx: () => void;
  onDetachSpec: () => void;
  onClearLocalAppState: () => void;
  isImporting: boolean;
  isImportingGoogleSheet: boolean;
  isGoogleConnecting: boolean;
  isRetryingGoogleSheetCheckboxDetection: boolean;
  isRebuildingGoogleRowIndex: boolean;
  googleAuthConfigured: boolean;
  googleAuthConnected: boolean;
  autoUpdateGoogleSheet: boolean;
  previewGoogleSheetWriteTargets: boolean;
  autoUpdateGoogleSheetDisabledReason: string | null;
  autoUpdateGoogleSheetValidationMessage: string | null;
  googleSheetWriteTargetPreviewInfo: string;
  manualCheckboxColumn: string;
  manualCheckboxColumnError: string | null;
  manualSheetTitle: string;
  canUseManualCheckboxColumn: boolean;
  canEditManualSheetTitle: boolean;
  canTestGoogleSheetWrite: boolean;
  canTestGoogleSheetExactG69: boolean;
  canTestGoogleSheetExactG85: boolean;
  canRebuildGoogleRowIndex: boolean;
  canSyncPendingGoogleSheetNow: boolean;
  syncPendingNowDisabledReason: string | null;
  canExportCheckedXlsx: boolean;
  exportCheckedXlsxTitle: string;
  exportCheckedXlsxHint: string | null;
  googleSheetDebugDetails: string;
  sheetSyncStatus: SidebarSheetSyncStatus;
  sheetSyncError: string | null;
  lastSheetSyncRowCount: number | null;
  pendingSheetUpdateCount: number;
  nextSheetSyncRetrySeconds: number | null;
  importError: string | null;
  googleSheetError: string | null;
  googleSheetImportInfo: string | null;
  googleSheetUrl: string;
  importWarnings: string[];
  activeFileName: string | null;
  activeSourceUrl: string | null;
  isUploadedXlsxGoogleSyncAttached: boolean;
  labels: {
    import: string;
    exportSectionTitle: string;
    detachSpec: string;
    reading: string;
    uploadSpec: string;
    fileImportFallback: string;
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
    save: string;
    debugDetails: string;
    exportCheckedXlsx: string;
    google: {
      sheetUrlPlaceholder: string;
      sheetUrlHint: string;
      importSheet: string;
      importingSheet: string;
      importSlowHint: string;
      cancelImport: string;
      useUploadedXlsxForGoogleSync: string;
      uploadedXlsxGoogleSyncHint: string;
      uploadedXlsxGoogleSyncLoaded: string;
      writeSyncTitle: string;
      connected: string;
      notConnected: string;
      connect: string;
      reconnect: string;
      disconnect: string;
      connecting: string;
      autoUpdate: string;
      sheetUrlHintPrefix?: string;
      sheetUrlHintStrongText?: string;
      sheetUrlHintSuffix?: string;
      sheetTabName: string;
      checkboxColumn: string;
      overrideCheckboxColumn: string;
      save: string;
      sheetSync: string;
      sheetSyncStatus: Record<SidebarSheetSyncStatus, string>;
      sheetSyncPending: (count: number) => string;
      lastSyncRows: (count: number) => string;
      debugDetails: string;
      noDebugDetails: string;
      importedSheet: string;
      previewWriteTargets: string;
      retryCheckboxDetection: string;
      retryingCheckboxDetection: string;
      rebuildRowIndex: string;
      rebuildRowIndexNow: string;
      rebuildingRowIndex: string;
      clearLocalAppState: string;
      testWriteFirstPassedRow: string;
      testWriteExactG69: string;
      testWriteExactG85: string;
      syncPendingNow: string;
      nextRetryIn: (seconds: number) => string;
    };
    loadedSpec: string;
    loadedGoogleSheetSpec: string;
    fileUploadUnavailableForGoogleSheet: string;
    ready: string;
    warnings: string;
    more: string;
  };
};

export function Sidebar({
  onSpecFile,
  onGoogleSheetImport,
  onGoogleSheetImportCancel,
  onGoogleSheetUrlChange,
  onGoogleConnect,
  onGoogleReconnect,
  onAutoUpdateGoogleSheetChange,
  onPreviewGoogleSheetWriteTargetsChange,
  onRebuildGoogleRowIndex,
  onRetryGoogleSheetCheckboxDetection,
  onManualCheckboxColumnChange,
  onManualSheetTitleChange,
  onSaveManualSheetTitle,
  onUseManualCheckboxColumn,
  onTestGoogleSheetWrite,
  onTestGoogleSheetExactG69,
  onTestGoogleSheetExactG85,
  onSyncPendingGoogleSheetNow,
  onExportCheckedXlsx,
  onDetachSpec,
  onClearLocalAppState,
  isImporting,
  isImportingGoogleSheet,
  isGoogleConnecting,
  isRetryingGoogleSheetCheckboxDetection,
  isRebuildingGoogleRowIndex,
  googleAuthConfigured,
  googleAuthConnected,
  autoUpdateGoogleSheet,
  previewGoogleSheetWriteTargets,
  autoUpdateGoogleSheetDisabledReason,
  autoUpdateGoogleSheetValidationMessage,
  googleSheetWriteTargetPreviewInfo,
  manualCheckboxColumn,
  manualCheckboxColumnError,
  manualSheetTitle,
  canUseManualCheckboxColumn,
  canEditManualSheetTitle,
  canTestGoogleSheetWrite,
  canTestGoogleSheetExactG69,
  canTestGoogleSheetExactG85,
  canRebuildGoogleRowIndex,
  canSyncPendingGoogleSheetNow,
  syncPendingNowDisabledReason,
  canExportCheckedXlsx,
  exportCheckedXlsxTitle,
  exportCheckedXlsxHint,
  googleSheetDebugDetails,
  sheetSyncStatus,
  sheetSyncError,
  lastSheetSyncRowCount,
  pendingSheetUpdateCount,
  nextSheetSyncRetrySeconds,
  importError,
  googleSheetError,
  googleSheetImportInfo,
  googleSheetUrl,
  importWarnings,
  activeFileName,
  activeSourceUrl,
  isUploadedXlsxGoogleSyncAttached,
  labels,
}: SidebarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const isImportBusy = isImporting || isImportingGoogleSheet;
  const isGoogleSheetSpecSource = activeSourceUrl !== null;
  const isFileUploadDisabled = isImportBusy || isGoogleSheetSpecSource;
  const autoUpdateGoogleSheetDisabled =
    autoUpdateGoogleSheetDisabledReason !== null;
  const sheetSyncDisplayStatus =
    sheetSyncStatus === "pending" && pendingSheetUpdateCount > 0
      ? labels.google.sheetSyncPending(pendingSheetUpdateCount)
      : labels.google.sheetSyncStatus[sheetSyncStatus];
  const trimmedSheetSyncMessage = sheetSyncError?.trim() ?? "";
  const shouldShowSheetSyncMessage =
    trimmedSheetSyncMessage.length > 0 &&
    !(previewGoogleSheetWriteTargets && sheetSyncStatus === "idle");
  const isSheetSyncWarning =
    sheetSyncStatus === "pending" &&
    pendingSheetUpdateCount > 0 &&
    trimmedSheetSyncMessage.length > 0;
  const shortSheetSyncMessage =
    trimmedSheetSyncMessage.length > 140
      ? `${trimmedSheetSyncMessage.slice(0, 140)}...`
      : trimmedSheetSyncMessage;
  const sheetSyncMessageClass =
    sheetSyncStatus === "failed"
      ? "text-red-400"
      : sheetSyncStatus === "synced"
        ? "text-emerald-300"
        : isSheetSyncWarning
          ? "text-amber-200/90"
          : "text-[#9ca3af]";
  const loadedSpecStatusLabel = isUploadedXlsxGoogleSyncAttached
    ? labels.google.uploadedXlsxGoogleSyncLoaded
    : isGoogleSheetSpecSource
      ? labels.loadedGoogleSheetSpec
      : labels.loadedSpec;
  const loadedSpecCard = activeFileName ? (
    <div
      className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.08] p-3 shadow-[inset_0_0_0_1px_rgba(16,185,129,0.08)]"
      title={activeSourceUrl ?? activeFileName}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold tracking-wide text-emerald-200/90">
          {loadedSpecStatusLabel}
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="rounded-full border border-emerald-400/35 bg-emerald-500/15 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-emerald-100">
            {labels.ready}
          </span>
          <button
            type="button"
            onClick={onDetachSpec}
            aria-label={labels.detachSpec}
            title={labels.detachSpec}
            className="ui-btn ui-btn-ghost ui-btn-icon-sm"
          >
            x
          </button>
        </div>
      </div>
      <p className="truncate text-[13px] font-semibold leading-snug text-[#f3f4f6]">
        {activeFileName}
      </p>
    </div>
  ) : null;

  return (
    <aside className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-[#2a2f3a] bg-[#171923] shadow-lg shadow-black/20">
      <div className="shrink-0 border-b border-[#2a2f3a] px-5 pb-4 pt-5">
        <h1 className="text-base font-semibold tracking-tight text-[#f3f4f6]">
          Analytics Checker
        </h1>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto border-b border-[#2a2f3a] px-5 py-4">
        <h2 className={sectionTitle}>{labels.import}</h2>
        <div className="space-y-2">
          <input
            type="url"
            value={googleSheetUrl}
            disabled={isImportBusy}
            placeholder={labels.google.sheetUrlPlaceholder}
            onChange={(e) => onGoogleSheetUrlChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                onGoogleSheetImport();
              }
            }}
            className="w-full rounded-lg border border-[#2a2f3a] bg-[#11131a] px-3 py-2 text-[12px] text-[#f3f4f6] outline-none transition placeholder:text-[#6b7280] focus:border-violet-500/50 disabled:cursor-not-allowed disabled:opacity-100"
          />
          <p className="text-[11px] leading-snug text-[#9ca3af]">
            {labels.google.uploadedXlsxGoogleSyncHint}
          </p>
          <button
            type="button"
            disabled={isImportBusy || googleSheetUrl.trim().length === 0}
            onClick={onGoogleSheetImport}
            className="ui-btn ui-btn-primary ui-btn-full"
          >
            {isImportingGoogleSheet
              ? labels.importingGoogleSheet
              : activeSourceUrl
                ? labels.google.importedSheet
                : labels.google.importSheet}
          </button>
          {isImportingGoogleSheet ? (
            <button
              type="button"
              onClick={onGoogleSheetImportCancel}
              className="ui-btn ui-btn-secondary ui-btn-full"
            >
              {labels.google.cancelImport}
            </button>
          ) : null}
          {googleSheetError ? (
            <p className="text-xs text-red-400">{googleSheetError}</p>
          ) : null}
          {googleSheetImportInfo ? (
            <p className="text-[11px] leading-snug text-[var(--warning-text)]">
              {googleSheetImportInfo}
            </p>
          ) : null}
          <div className="rounded-lg border border-[#2a2f3a] bg-[#1c1f2a]/50 p-2.5">
            <div className="flex flex-col gap-2">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold tracking-wide text-[#9ca3af]">
                  {labels.google.writeSyncTitle}
                </p>
                <p
                  className={`mt-0.5 text-[11px] ${
                    googleAuthConnected ? "text-emerald-300" : "text-[#d1d5db]"
                  }`}
                >
                  {googleAuthConnected
                    ? labels.google.connected
                    : labels.google.notConnected}
                </p>
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                {googleAuthConnected ? (
                  <button
                    type="button"
                    disabled={isGoogleConnecting || !googleAuthConfigured}
                    onClick={onGoogleReconnect}
                    className="ui-btn ui-btn-secondary ui-btn-sm min-h-7 max-w-full whitespace-normal px-2 py-1 text-center leading-snug"
                  >
                    {isGoogleConnecting
                      ? labels.google.connecting
                      : labels.google.reconnect}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={isGoogleConnecting || !googleAuthConfigured}
                    onClick={onGoogleConnect}
                    className="ui-btn ui-btn-primary ui-btn-sm min-h-7 max-w-full whitespace-normal px-2 py-1 text-center leading-snug"
                  >
                    {isGoogleConnecting
                      ? labels.google.connecting
                      : labels.google.connect}
                  </button>
                )}
              </div>
            </div>
            <label
              className="mt-2 flex items-start gap-2 text-[11px] leading-snug text-[#d1d5db]"
              onClick={(event) => {
                if (autoUpdateGoogleSheetDisabledReason === null) {
                  return;
                }
                event.preventDefault();
                onAutoUpdateGoogleSheetChange(true);
              }}
            >
              <input
                type="checkbox"
                checked={autoUpdateGoogleSheet}
                disabled={autoUpdateGoogleSheetDisabled}
                onChange={(e) =>
                  onAutoUpdateGoogleSheetChange(e.target.checked)
                }
                className={`mt-0.5 h-3.5 w-3.5 shrink-0 accent-violet-500 disabled:opacity-75 ${
                  autoUpdateGoogleSheetDisabled ? "pointer-events-none" : ""
                }`}
              />
              <span className="min-w-0 flex-1 leading-snug">
                <span>{labels.google.autoUpdate}</span>
                {autoUpdateGoogleSheetValidationMessage ? (
                  <span className="block text-amber-200/90">
                    {autoUpdateGoogleSheetValidationMessage}
                  </span>
                ) : null}
              </span>
            </label>
            <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-1.5">
              <input
                type="text"
                value={manualSheetTitle}
                disabled={!canEditManualSheetTitle}
                placeholder={labels.google.sheetTabName}
                onChange={(event) =>
                  onManualSheetTitleChange(event.target.value)
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    onSaveManualSheetTitle();
                  }
                }}
                className="h-7 min-w-0 rounded-md border border-[#2a2f3a] bg-[#11131a] px-2 text-[10px] text-[#f3f4f6] outline-none transition placeholder:text-[#6b7280] focus:border-violet-500/50 disabled:cursor-not-allowed disabled:opacity-100"
              />
              <button
                type="button"
                disabled={!canEditManualSheetTitle}
                onClick={onSaveManualSheetTitle}
                className="ui-btn ui-btn-secondary ui-btn-sm h-7"
              >
                {labels.google.save}
              </button>
            </div>
            <p className={`mt-2 text-[10px] leading-snug ${sheetSyncMessageClass}`}>
              {labels.google.sheetSync}: {sheetSyncDisplayStatus}
            </p>
            {lastSheetSyncRowCount !== null ? (
              <p className="mt-0.5 text-[10px] leading-snug text-emerald-300">
                {labels.google.lastSyncRows(lastSheetSyncRowCount)}
              </p>
            ) : null}
            {shouldShowSheetSyncMessage ? (
              <p className={`mt-1 text-[10px] leading-snug ${sheetSyncMessageClass}`}>
                {shortSheetSyncMessage}
              </p>
            ) : null}
            {nextSheetSyncRetrySeconds !== null ? (
              <p className="mt-0.5 text-[10px] leading-snug text-sky-200/85">
                {labels.google.nextRetryIn(nextSheetSyncRetrySeconds)}
              </p>
            ) : null}
            <details className="mt-2 rounded-md border border-[#2a2f3a] bg-[#11131a]/65">
              <summary className="cursor-pointer select-none px-2 py-1 text-[10px] font-medium text-[#9ca3af] transition hover:text-[#e5e7eb]">
                {labels.google.debugDetails}
              </summary>
              <div className="max-h-[180px] overflow-y-auto border-t border-[#2a2f3a] p-2">
                <pre className="whitespace-pre-wrap break-words font-mono text-[10px] leading-snug text-[#cbd5e1]">{googleSheetDebugDetails || labels.google.noDebugDetails}</pre>
                {googleSheetWriteTargetPreviewInfo ? (
                  <pre className="mt-2 whitespace-pre-wrap break-words border-t border-[#2a2f3a] pt-2 font-mono text-[10px] leading-snug text-sky-100/85">{googleSheetWriteTargetPreviewInfo}</pre>
                ) : null}
                <div className="mt-2 grid gap-1.5 font-sans">
                  <label className="grid gap-1 text-[10px] text-[#d1d5db]">
                    <span>{labels.google.overrideCheckboxColumn}</span>
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-1.5">
                      <input
                        type="text"
                        value={manualCheckboxColumn || "G"}
                        disabled={!canUseManualCheckboxColumn}
                        placeholder={labels.google.checkboxColumn}
                        onChange={(event) =>
                          onManualCheckboxColumnChange(event.target.value)
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            onUseManualCheckboxColumn();
                          }
                        }}
                        className="h-7 min-w-0 rounded-md border border-[#2a2f3a] bg-[#11131a] px-2 text-[10px] uppercase text-[#f3f4f6] outline-none transition placeholder:normal-case placeholder:text-[#6b7280] focus:border-violet-500/50 disabled:cursor-not-allowed disabled:opacity-100"
                      />
                      <button
                        type="button"
                        disabled={!canUseManualCheckboxColumn}
                        onClick={onUseManualCheckboxColumn}
                        className="ui-btn ui-btn-secondary ui-btn-sm h-7"
                      >
                        {labels.google.save}
                      </button>
                    </div>
                  </label>
                  {manualCheckboxColumnError ? (
                    <p className="text-[10px] leading-snug text-red-400">
                      {manualCheckboxColumnError}
                    </p>
                  ) : null}
                  <label className="flex flex-wrap items-center gap-2 text-[10px] text-[#d1d5db]">
                    <input
                      type="checkbox"
                      checked={previewGoogleSheetWriteTargets}
                      onChange={(event) =>
                        onPreviewGoogleSheetWriteTargetsChange(
                          event.target.checked,
                        )
                      }
                      className="h-3.5 w-3.5 accent-sky-500"
                    />
                    <span>{labels.google.previewWriteTargets}</span>
                  </label>
                  <button
                    type="button"
                    disabled={
                      !googleAuthConnected ||
                      isRetryingGoogleSheetCheckboxDetection
                    }
                    onClick={onRetryGoogleSheetCheckboxDetection}
                    className="ui-btn ui-btn-ghost ui-btn-sm ui-btn-full ui-btn-left"
                  >
                    {isRetryingGoogleSheetCheckboxDetection
                      ? labels.google.retryingCheckboxDetection
                      : labels.google.retryCheckboxDetection}
                  </button>
                  <button
                    type="button"
                    disabled={
                      !canRebuildGoogleRowIndex || isRebuildingGoogleRowIndex
                    }
                    onClick={onRebuildGoogleRowIndex}
                    className="ui-btn ui-btn-ghost ui-btn-sm ui-btn-full ui-btn-left"
                  >
                    {isRebuildingGoogleRowIndex
                      ? labels.google.rebuildingRowIndex
                      : labels.google.rebuildRowIndexNow}
                  </button>
                  <button
                    type="button"
                    disabled={!canSyncPendingGoogleSheetNow}
                    onClick={onSyncPendingGoogleSheetNow}
                    title={syncPendingNowDisabledReason ?? labels.google.syncPendingNow}
                    className="ui-btn ui-btn-secondary ui-btn-sm ui-btn-full ui-btn-left"
                  >
                    {labels.google.syncPendingNow}
                  </button>
                  <button
                    type="button"
                    onClick={onClearLocalAppState}
                    className="ui-btn ui-btn-danger ui-btn-sm ui-btn-full ui-btn-left"
                  >
                    {labels.google.clearLocalAppState}
                  </button>
                </div>
              </div>
            </details>
            {isGoogleSheetSpecSource ? (
              <div className="mt-2">{loadedSpecCard}</div>
            ) : null}
          </div>
        </div>
        <div className="space-y-2 border-t border-[#2a2f3a] pt-3">
          <p className="text-[10px] font-semibold tracking-wide text-[#6b7280]">
            {labels.fileImportFallback}
          </p>
          {googleSheetUrl.trim().length > 0 ||
          isUploadedXlsxGoogleSyncAttached ? (
            <p className="text-[10px] font-semibold uppercase tracking-wide text-sky-200/80">
              {labels.google.useUploadedXlsxForGoogleSync}
            </p>
          ) : null}
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            className="sr-only"
            disabled={isFileUploadDisabled}
            onChange={(e) => {
              if (isFileUploadDisabled) {
                e.target.value = "";
                return;
              }
              const file = e.target.files?.[0];
              if (file) onSpecFile(file);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            disabled={isFileUploadDisabled}
            onClick={() => {
              if (isFileUploadDisabled) {
                return;
              }
              inputRef.current?.click();
            }}
            className="ui-btn ui-btn-secondary ui-btn-full ui-btn-wrap ui-btn-stack"
          >
            {isImporting ? (
              labels.reading
            ) : (
              <>
                <span>{labels.uploadSpec}</span>
                <span className="ui-btn-subtext">.xlsx / .csv</span>
              </>
            )}
          </button>
          {isGoogleSheetSpecSource ? (
            <p className="text-[10px] leading-snug text-[#9ca3af]">
              {labels.fileUploadUnavailableForGoogleSheet}
            </p>
          ) : null}
        </div>
        {!isGoogleSheetSpecSource ? loadedSpecCard : null}
        {importError ? (
          <p className="text-xs text-red-400">{importError}</p>
        ) : null}
        {importWarnings.length > 0 ? (
          <div className="max-h-28 overflow-y-auto rounded-lg border border-amber-500/25 bg-amber-500/[0.08] p-2.5">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-amber-200/90">
              {labels.warnings} ({importWarnings.length})
            </p>
            <ul className="space-y-1 text-[11px] leading-snug text-amber-100/80">
              {importWarnings.slice(0, 12).map((w, i) => (
                <li key={i}>• {w}</li>
              ))}
            </ul>
            {importWarnings.length > 12 ? (
              <p className="mt-1 text-[10px] text-amber-200/60">
                +{importWarnings.length - 12} {labels.more}
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="space-y-2 border-t border-[#2a2f3a] pt-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-[#6b7280]">
            {labels.exportSectionTitle}
          </p>
          <button
            type="button"
            onClick={onExportCheckedXlsx}
            disabled={!canExportCheckedXlsx}
            title={exportCheckedXlsxTitle}
            className={[
              "ui-btn ui-btn-full",
              canExportCheckedXlsx ? "ui-btn-primary" : "ui-btn-secondary",
            ].join(" ")}
          >
            {labels.exportCheckedXlsx}
          </button>
          {exportCheckedXlsxHint ? (
            <p className="text-[10px] leading-snug text-[#9ca3af]">
              {exportCheckedXlsxHint}
            </p>
          ) : null}
        </div>
      </div>

    </aside>
  );
}
