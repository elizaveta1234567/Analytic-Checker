/**
 * Minimal configuration for iOS live syslog streaming via `idevicesyslog`.
 * This is intentionally separate from the Android ADB pipeline.
 */

/**
 * Path to `idevicesyslog` on Windows.
 * - Use an absolute `.exe` path if it's not in PATH.
 * - Default assumes `idevicesyslog` is available in PATH.
 */
export const idevicesyslogPath =
  "C:\\Users\\keliz\\libimobile-suite-latest_w64\\idevicesyslog.exe";

/**
 * Optional iOS device UDID to target when multiple devices are connected.
 * - `null` means "use default device selection" (tool-specific behavior).
 */
export const udid: string | null = "00008140-0004496A02E8401C";

/**
 * Maximum number of recent log lines to keep in memory for the iOS live stream.
 * Used for initial SSE replay and basic UI history.
 */
export const maxBufferedLogs = 200;

