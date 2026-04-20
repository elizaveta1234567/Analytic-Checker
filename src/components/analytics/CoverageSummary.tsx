export type CoverageSummaryData = {
  covered: number;
  total: number;
  coveragePercent: number;
  passedRows: number;
  partialRows: number;
  notCheckedRows: number;
};

export type CoverageSummaryProps = {
  data: CoverageSummaryData;
};

export function CoverageSummary({ data }: CoverageSummaryProps) {
  const {
    covered,
    total,
    coveragePercent,
    passedRows,
    partialRows,
    notCheckedRows,
  } = data;

  return (
    <div className="shrink-0 rounded-xl border border-[#2a2f3a] bg-[#1c1f2a] px-4 py-3 shadow-md shadow-black/15">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[#9ca3af]">
        Spec coverage
      </p>
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 text-sm text-[#e5e7eb]">
        <span>
          Covered rows:{" "}
          <span className="font-semibold tabular-nums text-[#f3f4f6]">
            {covered} / {total}
          </span>
        </span>
        <span>
          Coverage:{" "}
          <span className="font-semibold tabular-nums text-violet-200/95">
            {coveragePercent}%
          </span>
        </span>
        <span className="text-[#9ca3af]">
          Passed rows:{" "}
          <span className="font-medium tabular-nums text-emerald-400/90">
            {passedRows}
          </span>
        </span>
        <span className="text-[#9ca3af]">
          Partial:{" "}
          <span className="font-medium tabular-nums text-orange-400/90">
            {partialRows}
          </span>
        </span>
        <span className="text-[#9ca3af]">
          Not checked:{" "}
          <span className="font-medium tabular-nums text-[#d1d5db]">
            {notCheckedRows}
          </span>
        </span>
      </div>
    </div>
  );
}
