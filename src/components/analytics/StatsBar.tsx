import { StatusDot } from "./StatusDot";
import { MOCK_STAT_CARDS } from "./mock-ui";

export type StatsBarCounts = {
  passedLogs: number;
  duplicateLogs: number;
  unknownLogs: number;
  partialLogs: number;
  notCheckedRows: number;
};

export type StatsBarProps = {
  /** When set (including after Process with zeros), replaces mock card values. */
  counts?: StatsBarCounts | null;
  labels: {
    passed: string;
    duplicate: string;
    unknown: string;
    partial: string;
    notChecked: string;
  };
};

function translateStatLabel(
  label: string,
  labels: StatsBarProps["labels"],
): string {
  switch (label.toLowerCase()) {
    case "passed":
      return labels.passed;
    case "duplicate":
    case "duplicates":
      return labels.duplicate;
    case "unknown":
      return labels.unknown;
    case "partial":
      return labels.partial;
    case "not checked":
      return labels.notChecked;
    default:
      return label;
  }
}

export function StatsBar({ counts, labels }: StatsBarProps) {
  const cards =
    counts === null || counts === undefined
      ? MOCK_STAT_CARDS
      : [
          {
            id: "passed",
            label: labels.passed,
            value: String(counts.passedLogs),
            variant: "passed" as const,
          },
          {
            id: "dup",
            label: labels.duplicate,
            value: String(counts.duplicateLogs),
            variant: "duplicate" as const,
          },
          {
            id: "unk",
            label: labels.unknown,
            value: String(counts.unknownLogs),
            variant: "unknown" as const,
          },
          {
            id: "nc",
            label: labels.notChecked,
            value: String(counts.notCheckedRows),
            variant: "unchecked" as const,
          },
        ];

  return (
    <div className="grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-4">
      {cards.map((card) => (
        <div
          key={card.id}
          className="rounded-xl border border-[#2a2f3a] bg-[#1c1f2a] p-4 shadow-md shadow-black/20"
        >
          <div className="flex items-center gap-2">
            <StatusDot variant={card.variant} />
            <span className="text-[11px] font-medium uppercase tracking-wide text-[#9ca3af]">
              {translateStatLabel(card.label, labels)}
            </span>
          </div>
          <p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight text-[#f3f4f6]">
            {card.value}
          </p>
        </div>
      ))}
    </div>
  );
}
