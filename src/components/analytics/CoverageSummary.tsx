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
  labels: {
    specCoverage: string;
    coveredRows: string;
    coverage: string;
    passedRows: string;
    partial: string;
    notChecked: string;
  };
};

export function CoverageSummary({ data, labels }: CoverageSummaryProps) {
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
        {labels.specCoverage}
      </p>
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 text-sm text-[#e5e7eb]">
        <span>
          {labels.coveredRows}:{" "}
          <span className="font-semibold tabular-nums text-[#f3f4f6]">
            {covered} / {total}
          </span>
        </span>
        <span>
          {labels.coverage}:{" "}
          <span className="font-semibold tabular-nums text-violet-200/95">
            {coveragePercent}%
          </span>
        </span>
        <span className="text-[#9ca3af]">
          {labels.passedRows}:{" "}
          <span className="font-medium tabular-nums text-emerald-400/90">
            {passedRows}
          </span>
        </span>
        <span className="text-[#9ca3af]">
          {labels.partial}:{" "}
          <span className="font-medium tabular-nums text-orange-400/90">
            {partialRows}
          </span>
        </span>
        <span className="text-[#9ca3af]">
          {labels.notChecked}:{" "}
          <span className="font-medium tabular-nums text-[#d1d5db]">
            {notCheckedRows}
          </span>
        </span>
      </div>
    </div>
  );
}
