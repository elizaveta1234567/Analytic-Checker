import os from "os";
import path from "path";

export const defaultUnityEditorLogPath = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "Unity",
  "Editor",
  "Editor.log",
);

export const maxBufferedLogs = 200;
export const pollIntervalMs = 500;
export const maxReadChunkBytes = 1024 * 1024;
