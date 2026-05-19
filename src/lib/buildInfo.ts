export const appBuildInfo = {
  version: process.env.NEXT_PUBLIC_APP_VERSION ?? "0.1.0",
  timestamp: process.env.NEXT_PUBLIC_BUILD_TIMESTAMP ?? "unknown",
  gitCommit: process.env.NEXT_PUBLIC_GIT_COMMIT ?? "unknown",
  gitDirty: process.env.NEXT_PUBLIC_GIT_DIRTY ?? "unknown",
};
