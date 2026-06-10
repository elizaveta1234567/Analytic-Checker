#if ANALYTICS_LOG_BRIDGE_LUNAR_CONSOLE
using LunarConsolePlugin;
using UnityEngine;

/// <summary>
/// LunarConsole user actions (PRO). Define ANALYTICS_LOG_BRIDGE_LUNAR_CONSOLE when LunarConsole is installed.
/// </summary>
[DisallowMultipleComponent]
public sealed class AnalyticsLogBridgeLunarRegistrar : MonoBehaviour
{
    private void Start()
    {
        if (!AnalyticsLogBridge.IsBridgeEnabled())
        {
            return;
        }

        LunarConsole.RegisterAction("Copy analytics log", AnalyticsLogBridge.ExportLogToClipboard);
        LunarConsole.RegisterAction("Export analytics log", AnalyticsLogBridge.LogExportPath);
    }

    private void OnDestroy()
    {
        LunarConsole.UnregisterAllActions(this);
    }
}
#endif
