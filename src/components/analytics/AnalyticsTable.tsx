import { StatusDot } from "./StatusDot";
import type { TableRowModel } from "./specRowDisplay";

const thClass =
  "px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-[#9ca3af]";

export type AnalyticsTableProps = {
  rows: TableRowModel[];
  selectedRowId: string | null;
  onSelectRow: (id: string) => void;
  /** True when a file was loaded but produced zero spec rows. */
  isEmptyImport: boolean;
  /** When rows come from a real file import (vs mock preview). */
  isImported: boolean;
};

export function AnalyticsTable({
  rows,
  selectedRowId,
  onSelectRow,
  isEmptyImport,
  isImported,
}: AnalyticsTableProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[#2a2f3a] bg-[#1c1f2a] shadow-lg shadow-black/25">
      <div className="shrink-0 border-b border-[#2a2f3a] px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-[#f3f4f6]">Events</h2>
          {isImported ? (
            <span className="rounded-md border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-200">
              Imported
            </span>
          ) : (
            <span className="text-[10px] font-medium uppercase tracking-wide text-[#9ca3af]">
              Mock preview
            </span>
          )}
        </div>
        {!isImported && (
          <p className="mt-1 text-xs text-[#9ca3af]">
            Upload a spec file in the sidebar to replace this sample data.
          </p>
        )}
      </div>

      <div className="h-full min-h-0 flex-1 overflow-auto">
        {isEmptyImport ? (
          <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
            <p className="text-sm text-[#e5e7eb]">No rows parsed</p>
            <p className="max-w-sm text-xs text-[#9ca3af]">
              The file was read, but no meaningful rows were found. Try another
              sheet or check that cells are not all empty.
            </p>
          </div>
        ) : (
          <table className="w-full min-w-[520px] border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-[#1c1f2a]/95 backdrop-blur-sm">
              <tr className="border-b border-[#2a2f3a]">
                <th className={`${thClass} pl-4`} scope="col">
                  Status
                </th>
                <th className={thClass} scope="col">
                  Event
                </th>
                <th className={thClass} scope="col">
                  Value
                </th>
                <th className={`${thClass} pr-4`} scope="col">
                  Description
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const selected = row.id === selectedRowId;
                return (
                  <tr
                    key={row.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelectRow(row.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelectRow(row.id);
                      }
                    }}
                    className={[
                      "cursor-pointer border-b border-[#2a2f3a]/80 transition-colors",
                      selected
                        ? "bg-violet-500/10 ring-1 ring-inset ring-violet-500/25"
                        : "hover:bg-[#232736]/90",
                    ].join(" ")}
                  >
                    <td className="px-3 py-2.5 pl-4 align-middle">
                      <span className="inline-flex items-center gap-2">
                        <StatusDot variant={row.dotStatus} />
                        <span className="capitalize text-[#d1d5db]">
                          {row.statusLabel}
                        </span>
                      </span>
                    </td>
                    <td className="px-3 py-2.5 align-middle font-mono text-[13px] text-violet-200/95">
                      {row.event}
                    </td>
                    <td className="max-w-[140px] truncate px-3 py-2.5 align-middle font-mono text-[12px] text-[#9ca3af]">
                      {row.value ?? "—"}
                    </td>
                    <td className="px-3 py-2.5 pr-4 align-middle text-[#9ca3af]">
                      {row.description}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
