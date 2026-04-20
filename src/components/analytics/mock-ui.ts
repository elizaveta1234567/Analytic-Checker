import type { StatusDotVariant } from "./StatusDot";

/** Static copy for sidebar spec list (no state). */
export const MOCK_SPEC_ITEMS = [
  { id: "s1", label: "Week 52 — full pass" },
  { id: "s2", label: "Shop events v2" },
  { id: "s3", label: "Tutorial funnel" },
  { id: "s4", label: "Retention export" },
] as const;

/** Which spec row looks “active” in the mock. */
export const MOCK_ACTIVE_SPEC_ID = "s2";

export const MOCK_FILTER_ITEMS = [
  { id: "all", label: "All" },
  { id: "passed", label: "Passed" },
  { id: "duplicate", label: "Duplicate" },
  { id: "unknown", label: "Unknown" },
  { id: "not_checked", label: "Not checked" },
] as const;

export const MOCK_ACTIVE_FILTER_ID = "all";

export type MockTableRow = {
  id: string;
  status: StatusDotVariant;
  event: string;
  value: string;
  description: string;
};

export const MOCK_TABLE_ROWS: MockTableRow[] = [
  {
    id: "r1",
    status: "passed",
    event: "game.session.start",
    value: "—",
    description: "Cold start, build 1.4.2",
  },
  {
    id: "r2",
    status: "passed",
    event: "shop.view_open",
    value: "tab=featured",
    description: "Opened shop from hub",
  },
  {
    id: "r3",
    status: "duplicate",
    event: "iap.purchase_attempt",
    value: "sku_gold_pack",
    description: "Duplicate within 2s window",
  },
  {
    id: "r4",
    status: "unknown",
    event: "legacy.banner_tap",
    value: "id=unknown",
    description: "Not present in current spec",
  },
  {
    id: "r5",
    status: "unchecked",
    event: "tutorial.step_complete",
    value: "step=3",
    description: "Waiting for log ingest",
  },
  {
    id: "r6",
    status: "passed",
    event: "meta.ads.impression",
    value: "placement=interstitial",
    description: "Mediation callback",
  },
  {
    id: "r7",
    status: "unchecked",
    event: "social.share",
    value: "channel=twitter",
    description: "Optional event",
  },
  {
    id: "r8",
    status: "duplicate",
    event: "analytics.flush",
    value: "batch=12",
    description: "Batch flush (duplicate)",
  },
];

/** Row that appears selected in the static mock. */
export const MOCK_SELECTED_ROW_ID = "r3";

export const MOCK_STAT_CARDS = [
  { id: "passed", label: "Passed", value: "42", variant: "passed" as const },
  { id: "dup", label: "Duplicates", value: "3", variant: "duplicate" as const },
  { id: "unk", label: "Unknown", value: "5", variant: "unknown" as const },
  {
    id: "nc",
    label: "Not checked",
    value: "12",
    variant: "unchecked" as const,
  },
];

export const MOCK_RECENT_LOG_ITEMS = [
  {
    id: "l1",
    line: "[14:02:01] game.session.start { build: \"1.4.2\" }",
    status: "passed" as const,
  },
  {
    id: "l2",
    line: "[14:02:04] shop.view_open { tab: \"featured\" }",
    status: "passed" as const,
  },
  {
    id: "l3",
    line: "[14:02:09] legacy.banner_tap { id: \"??\" }",
    status: "unknown" as const,
  },
];
