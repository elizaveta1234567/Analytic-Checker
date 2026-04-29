"use client";

import type { AnalyticsSpecRow } from "@/lib/analytics/types";
import { useMemo, useState } from "react";

function rowFields(row: AnalyticsSpecRow) {
  const eventPath = String(row.cells.eventPath ?? row.hierarchy.join("."));
  const rawVal = row.cells.value;
  const value =
    rawVal === null || rawVal === undefined || rawVal === ""
      ? null
      : String(rawVal);
  const description =
    row.cells.description != null ? String(row.cells.description) : "";
  return { eventPath, value, description };
}

export type MissingEventsBlockProps = {
  /** Spec rows with `not_checked` status (pre-filtered in parent). */
  rows: AnalyticsSpecRow[];
};

export function MissingEventsBlock(
  props: MissingEventsBlockProps,
) {
  const { rows } = props;
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const { eventPath, value, description } = rowFields(r);
      return (
        eventPath.toLowerCase().includes(q) ||
        (value?.toLowerCase().includes(q) ?? false) ||
        description.toLowerCase().includes(q)
      );
    });
  }, [rows, query]);

  const allCovered = rows.length === 0;

  return (
    <div className="flex min-h-0 max-h-[min(220px,32vh)] shrink-0 flex-col gap-2 rounded-xl border border-[#2a2f3a] bg-[#1c1f2a] shadow-md shadow-black/15">
      <div className="shrink-0 border-b border-[#2a2f3a] px-3 py-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[#9ca3af]">
          Missing events
        </h3>
        {!allCovered ? (
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by path, value, description..."
            className="mt-2 w-full rounded-lg border border-[#2a2f3a] bg-[#171923] px-2.5 py-1.5 text-xs text-[#f3f4f6] placeholder:text-[#6b7280] focus:border-violet-500/40 focus:outline-none focus:ring-1 focus:ring-violet-500/25"
          />
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 pb-3">
        {allCovered ? (
          <p className="py-4 text-center text-xs text-[#9ca3af]">
            All imported events were covered
          </p>
        ) : filtered.length === 0 ? (
          <p className="py-3 text-center text-xs text-[#6b7280]">
            No rows match filter
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {filtered.map((row) => {
              const { eventPath, value, description } = rowFields(row);
              return (
                <li
                  key={row.id}
                  className="rounded-lg border border-[#2a2f3a]/80 bg-[#171923]/80 px-2.5 py-2"
                >
                  <p className="font-mono text-[12px] leading-snug text-violet-200/95">
                    {eventPath}
                  </p>
                  {value ? (
                    <p className="mt-0.5 font-mono text-[11px] text-[#9ca3af]">
                      value: {value}
                    </p>
                  ) : null}
                  {description ? (
                    <p className="mt-0.5 text-[11px] leading-snug text-[#9ca3af]">
                      {description}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
