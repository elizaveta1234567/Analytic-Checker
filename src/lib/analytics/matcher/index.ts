export { makeRowKey, buildEventPathIndex, buildRowMap, buildMatcherIndexes } from "./buildIndexes";
export type { MatcherIndexes } from "./buildIndexes";
export { computeStats } from "./computeStats";
export type { LogStats, MatcherStats, RowStats } from "./computeStats";
export {
  applyMatchToRows,
  matchLogLinesAgainstSpec,
  matchPayload,
} from "./matchLogs";
export type { MatchPayloadResult } from "./matchLogs";
export { normalizeValue } from "./normalize";
export {
  extractAnalyticsPayload,
  validateExtractedPayload,
} from "./parseLogs";
