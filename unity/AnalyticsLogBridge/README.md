# AnalyticsLogBridge (Unity iOS dev)

Drop-in bridge for QA: duplicates analytics `Debug.Log` lines into `analytics_live.log` without reading LunarConsole UI.

## Where the log lines come from

This repo does **not** contain the game Unity project. In a typical setup the strings are emitted by game code, for example:

| Prefix | Usual source |
|--------|----------------|
| `[AnalyticsController] reported event:` | `AnalyticsController` (or wrapper) calling `Debug.Log` / `UnityEngine.Debug.Log` when AppMetrica/internal events fire |
| `[AppsFlyerAnalytics] send AppsFlyer event [...]` | AppsFlyer SDK wrapper logging outbound events |

LunarConsole only **displays** these lines; it is not the author. The bridge hooks `Application.logMessageReceivedThreaded`, so any existing `Debug.Log` with those prefixes is captured **without** changing AnalyticsController or AppsFlyer code.

To find the exact call sites in your game repo, search C# for:

```
reported event:
AppsFlyerAnalytics
send AppsFlyer event
```

## Install

1. Copy `unity/AnalyticsLogBridge/` into your Unity project (e.g. `Assets/Scripts/AnalyticsLogBridge/`).
2. (Optional) LunarConsole actions: add scripting define `ANALYTICS_LOG_BRIDGE_LUNAR_CONSOLE` for the target platform.
3. Build an **iOS Development** build (`Development Build` checked in Build Settings).

## Behaviour

- **Enabled when:** Unity Editor, `DEVELOPMENT_BUILD` + `Debug.isDebugBuild`, or manual define `ANALYTICS_LOG_BRIDGE`.
- **Disabled when:** Release player build (no define) — zero subscription, no file IO.
- **File:** `{Application.persistentDataPath}/analytics_live.log` (on iOS this is the app Documents folder).
- **Filter:** only lines containing:
  - `[AnalyticsController] reported event:`
  - `[AppsFlyerAnalytics] send AppsFlyer event`
- Parameter-only lines (`"Music": {`, etc.) are **not** written (same as Analytics Checker).
- IO failures are swallowed; the game continues.

## iOS: get the file (iMazing / Finder)

The editor post-processor sets for **Development** iOS builds:

- `UIFileSharingEnabled = true`
- `LSSupportsOpeningDocumentsInPlace = true`

After installing the dev build on device:

1. Run the game and trigger analytics.
2. In Finder (macOS) or iMazing: app container → **Documents** → `analytics_live.log`.

## LunarConsole (optional)

With scripting define `ANALYTICS_LOG_BRIDGE_LUNAR_CONSOLE` (requires LunarConsole **PRO** for `RegisterAction`):

- **Copy analytics log** — copies file contents to clipboard.
- **Export analytics log** — prints full path in device log (`[AnalyticsLogBridge] analytics log: ...`).

## Analytics Checker

On the **iOS** tab: **Upload LunarConsole log** → choose `analytics_live.log` (or paste lines). Same parser as LunarConsole paste.

## Production safety

Do **not** add `ANALYTICS_LOG_BRIDGE` to release builds. Release builds without `DEVELOPMENT_BUILD` do not load the bridge.

If you need a custom non-dev QA build, use a dedicated build configuration with `ANALYTICS_LOG_BRIDGE` and still avoid App Store release defines.
