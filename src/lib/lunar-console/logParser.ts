import {
  parseUnityAnalyticsLogLine,
  type UnityAnalyticsLogLine,
} from "@/lib/unity-editor-log/logParser";

export type IosLunarAnalyticsLogLine = UnityAnalyticsLogLine;

const LUNAR_PARAMETER_LINE_RE = /^\s*"[^"]+"\s*:\s*\{?\s*$/;

export function isLunarConsoleParameterLine(line: string): boolean {
  return LUNAR_PARAMETER_LINE_RE.test(line.trim());
}

export function parseIosLunarConsoleLogLine(
  rawLine: string,
): IosLunarAnalyticsLogLine | null {
  const trimmed = rawLine.replace(/\r$/, "").trim();
  if (trimmed === "" || isLunarConsoleParameterLine(trimmed)) {
    return null;
  }
  return parseUnityAnalyticsLogLine(rawLine);
}

export function isIosLunarAnalyticsCandidateLine(rawLine: string): boolean {
  return parseIosLunarConsoleLogLine(rawLine) !== null;
}
