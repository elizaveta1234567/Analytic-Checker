"use client";

import { useRef } from "react";

const sectionTitle =
  "mb-2 text-[11px] font-semibold uppercase tracking-wider text-[#9ca3af]";

const listItemBase =
  "flex w-full items-center rounded-lg border border-transparent px-2.5 py-2 text-left text-[13px] transition-colors";

const listItemIdle =
  "text-[#d1d5db] hover:border-[#2a2f3a] hover:bg-[#1c1f2a] hover:text-[#f3f4f6]";

const listItemActive =
  "border-violet-500/30 bg-violet-500/10 text-violet-100 shadow-[inset_0_0_0_1px_rgba(139,92,246,0.15)]";

export type SidebarFilter =
  | "all"
  | "passed"
  | "duplicate"
  | "unknown"
  | "not_checked";

const filterItems: Array<{ id: SidebarFilter }> = [
  { id: "all" },
  { id: "passed" },
  { id: "duplicate" },
  { id: "unknown" },
  { id: "not_checked" },
];

export type SidebarProps = {
  onSpecFile: (file: File) => void;
  isImporting: boolean;
  importError: string | null;
  importWarnings: string[];
  activeFileName: string | null;
  activeFilter: SidebarFilter;
  onFilterChange: (filter: SidebarFilter) => void;
  labels: {
    import: string;
    reading: string;
    uploadSpec: string;
    loadedSpec: string;
    ready: string;
    warnings: string;
    more: string;
    filters: string;
    filterLabels: Record<SidebarFilter, string>;
  };
};

export function Sidebar({
  onSpecFile,
  isImporting,
  importError,
  importWarnings,
  activeFileName,
  activeFilter,
  onFilterChange,
  labels,
}: SidebarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <aside className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-[#2a2f3a] bg-[#171923] shadow-lg shadow-black/20">
      <div className="shrink-0 border-b border-[#2a2f3a] px-5 pb-4 pt-5">
        <h1 className="text-base font-semibold tracking-tight text-[#f3f4f6]">
          Analytics Checker
        </h1>
      </div>

      <div className="shrink-0 space-y-4 border-b border-[#2a2f3a] px-5 py-4">
        <h2 className={sectionTitle}>{labels.import}</h2>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onSpecFile(file);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          disabled={isImporting}
          onClick={() => inputRef.current?.click()}
          className="w-full rounded-lg border border-[#2a2f3a] bg-[#1c1f2a] px-3 py-2.5 text-[13px] font-medium text-[#f3f4f6] transition hover:border-violet-500/40 hover:bg-[#232736] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isImporting ? labels.reading : labels.uploadSpec}
        </button>
        {activeFileName ? (
          <div
            className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.08] p-3 shadow-[inset_0_0_0_1px_rgba(16,185,129,0.08)]"
            title={activeFileName}
          >
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-200/90">
                {labels.loadedSpec}
              </p>
              <span className="rounded-full border border-emerald-400/35 bg-emerald-500/15 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-emerald-100">
                {labels.ready}
              </span>
            </div>
            <p className="truncate text-[13px] font-semibold leading-snug text-[#f3f4f6]">
              {activeFileName}
            </p>
          </div>
        ) : null}
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
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-4">
        <div>
          <h2 className={sectionTitle}>{labels.filters}</h2>
          <ul className="flex flex-col gap-0.5">
            {filterItems.map((item) => {
              const active = item.id === activeFilter;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => onFilterChange(item.id)}
                    className={`${listItemBase} ${active ? listItemActive : listItemIdle}`}
                  >
                    {labels.filterLabels[item.id]}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </nav>
    </aside>
  );
}
