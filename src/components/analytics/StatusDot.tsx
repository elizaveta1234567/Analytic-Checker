export type StatusDotVariant =
  | "passed"
  | "duplicate"
  | "partial"
  | "unknown"
  | "unchecked";

const variantClass: Record<StatusDotVariant, string> = {
  passed: "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.35)]",
  duplicate: "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.25)]",
  partial: "bg-orange-400 shadow-[0_0_8px_rgba(251,146,60,0.28)]",
  unknown: "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.3)]",
  unchecked: "bg-neutral-500",
};

type StatusDotProps = {
  variant: StatusDotVariant;
  className?: string;
};

export function StatusDot({ variant, className = "" }: StatusDotProps) {
  return (
    <span
      className={`inline-block size-2 shrink-0 rounded-full ${variantClass[variant]} ${className}`}
      aria-hidden
    />
  );
}
