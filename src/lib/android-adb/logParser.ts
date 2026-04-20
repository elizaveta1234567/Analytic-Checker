import { extractAnalyticsPayload } from "@/lib/analytics/matcher/parseLogs";

/**
 * `adb logcat` threadtime (default-style) line:
 * MM-DD HH:MM:SS.mmm PID TID LEVEL TAG : message
 */
const LOGCAT_THREADTIME_RE =
  /^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3}\s+\d+\s+\d+\s+[VDIWEF]\s+[^:]+:\s*(.*)$/;

/**
 * Brief format: LEVEL/TAG(PID): message
 */
const LOGCAT_BRIEF_RE = /^[VDIWEF]\/[^\s(]+\(\s*\d+\):\s*(.*)$/;

/**
 * Strips common logcat prefixes and returns the app print message (or the whole
 * trimmed line if no known prefix matched — e.g. pasted console-only text).
 */
export function extractLogcatMessage(rawLine: string): string {
  const line = rawLine.replace(/\r$/, "");
  const t = line.trimEnd();
  const thread = t.match(LOGCAT_THREADTIME_RE);
  if (thread?.[1] !== undefined) {
    return thread[1].trimEnd();
  }
  const brief = t.match(LOGCAT_BRIEF_RE);
  if (brief?.[1] !== undefined) {
    return brief[1].trimEnd();
  }
  return t.trim();
}

/** True if the line is an analytics line after logcat unwrapping (Node-side filter). */
export function isAnalyticsAdbLine(rawLine: string): boolean {
  return extractAnalyticsPayload(extractLogcatMessage(rawLine)) !== null;
}

/**
 * Returns the logcat message body for downstream matching if it is an analytics
 * line; otherwise null. Does not alter payload text beyond trimEnd on the message.
 */
export function normalizeAdbLogLine(rawLine: string): string | null {
  const msg = extractLogcatMessage(rawLine);
  if (extractAnalyticsPayload(msg) === null) {
    return null;
  }
  return msg.trim();
}
