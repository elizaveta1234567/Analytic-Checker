using System;
using System.IO;
using System.Text;
using System.Threading;
using UnityEngine;

/// <summary>
/// Dev-only bridge: captures analytics-related Debug.Log lines into analytics_live.log.
/// Does nothing in non-development player builds unless ANALYTICS_LOG_BRIDGE is defined.
/// </summary>
[DisallowMultipleComponent]
public sealed class AnalyticsLogBridge : MonoBehaviour
{
    public const string LogFileName = "analytics_live.log";

    private static readonly object FileLock = new object();
    private static AnalyticsLogBridge _instance;
    private static string _logFilePath;
    private static int _isSubscribed;

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
    private static void AutoInitialize()
    {
        if (!IsBridgeEnabled())
        {
            return;
        }

        if (_instance != null)
        {
            return;
        }

        var host = new GameObject("[AnalyticsLogBridge]");
        host.hideFlags = HideFlags.HideAndDontSave;
        DontDestroyOnLoad(host);
        _instance = host.AddComponent<AnalyticsLogBridge>();
    }

    public static bool IsBridgeEnabled()
    {
#if UNITY_EDITOR
        return true;
#elif DEVELOPMENT_BUILD
        return Debug.isDebugBuild;
#elif ANALYTICS_LOG_BRIDGE
        return true;
#else
        return false;
#endif
    }

    public static string LogFilePath
    {
        get
        {
            if (string.IsNullOrEmpty(_logFilePath))
            {
                _logFilePath = Path.Combine(Application.persistentDataPath, LogFileName);
            }

            return _logFilePath;
        }
    }

    public static bool IsAnalyticsLogLine(string message)
    {
        if (string.IsNullOrEmpty(message))
        {
            return false;
        }

        return message.Contains("[AnalyticsController] reported event:", StringComparison.Ordinal) ||
               message.Contains("[AppsFlyerAnalytics] send AppsFlyer event", StringComparison.Ordinal);
    }

    public static string ReadFullLogSafe()
    {
        try
        {
            var path = LogFilePath;
            return File.Exists(path) ? File.ReadAllText(path, Encoding.UTF8) : string.Empty;
        }
        catch
        {
            return string.Empty;
        }
    }

    public static void ExportLogToClipboard()
    {
        try
        {
            GUIUtility.systemCopyBuffer = ReadFullLogSafe();
            Debug.Log($"[AnalyticsLogBridge] Copied log to clipboard ({ReadFullLogSafe().Length} chars).");
        }
        catch (Exception ex)
        {
            Debug.LogWarning($"[AnalyticsLogBridge] Copy failed: {ex.Message}");
        }
    }

    public static void LogExportPath()
    {
        Debug.Log($"[AnalyticsLogBridge] analytics log: {LogFilePath}");
    }

    private void Awake()
    {
        if (_instance != null && _instance != this)
        {
            Destroy(gameObject);
            return;
        }

        _instance = this;
        DontDestroyOnLoad(gameObject);
        EnsureSubscribed();
        TryWriteSessionHeader();
#if ANALYTICS_LOG_BRIDGE_LUNAR_CONSOLE
        if (GetComponent<AnalyticsLogBridgeLunarRegistrar>() == null)
        {
            gameObject.AddComponent<AnalyticsLogBridgeLunarRegistrar>();
        }
#endif
    }

    private void OnEnable()
    {
        EnsureSubscribed();
    }

    private void OnDisable()
    {
        if (_instance == this)
        {
            Unsubscribe();
        }
    }

    private void OnDestroy()
    {
        if (_instance == this)
        {
            Unsubscribe();
            _instance = null;
        }
    }

    private static void EnsureSubscribed()
    {
        if (!IsBridgeEnabled())
        {
            return;
        }

        if (Interlocked.CompareExchange(ref _isSubscribed, 1, 0) == 0)
        {
            Application.logMessageReceivedThreaded += OnLogMessageReceivedThreaded;
        }
    }

    private static void Unsubscribe()
    {
        if (Interlocked.CompareExchange(ref _isSubscribed, 0, 1) == 1)
        {
            Application.logMessageReceivedThreaded -= OnLogMessageReceivedThreaded;
        }
    }

    private static void TryWriteSessionHeader()
    {
        try
        {
            AppendLine($"# session start {DateTime.UtcNow:O} persistentDataPath={Application.persistentDataPath}");
        }
        catch
        {
            // Never affect gameplay.
        }
    }

    private static void OnLogMessageReceivedThreaded(string condition, string stackTrace, LogType type)
    {
        if (!IsBridgeEnabled() || !IsAnalyticsLogLine(condition))
        {
            return;
        }

        AppendLine(condition);
    }

    private static void AppendLine(string line)
    {
        if (string.IsNullOrEmpty(line))
        {
            return;
        }

        try
        {
            var payload = line.Replace("\r\n", "\n").Replace('\r', '\n');
            lock (FileLock)
            {
                File.AppendAllText(LogFilePath, payload + Environment.NewLine, Encoding.UTF8);
            }
        }
        catch
        {
            // Swallow IO errors (disk full, permissions, etc.).
        }
    }
}
